use anyhow::Result;

use crate::{backend, models};

pub fn run(
    no_cache: bool,
    #[cfg(feature = "tts")] tts: bool,
    vad: bool,
    #[cfg(feature = "system_diarize")] diarize: bool,
    no_warmup: bool,
) -> Result<()> {
    // Emit the "Model mirror active" banner once at the start of the
    // install run, regardless of which subset of models the flags
    // request. Push-down to `download_*` is more "magic" — each fn
    // hides a stderr write behind its Ok(()) return.
    models::init_mirror_logging();
    models::install(no_cache)?;
    #[cfg(feature = "tts")]
    if tts {
        models::download_tts(no_cache)?;
        eprintln!("TTS models installed.");
    }
    if vad {
        models::download_vad(no_cache)?;
        eprintln!("VAD model installed.");
    }
    #[cfg(feature = "system_diarize")]
    if diarize {
        models::download_diarize(no_cache)?;
        eprintln!("Diarization model installed.");
    }
    // ASR backend warm-up: instantiate the backend once so the
    // expensive cold-start work — Apple Neural Engine model-compile
    // on CoreML (~20-30 s for Parakeet TDT 0.6B), ORT session init
    // on the ONNX path (~500 ms) — happens HERE, during the install
    // step where the user is already waiting on multi-GB downloads.
    // After this, the first real `kesha audio.ogg` is fast because
    // the macOS CoreML cache is keyed by (model bytes, signing
    // identity); the identity is stable across runs of the same
    // binary, so the warm cache survives until the next
    // `kesha install` re-signs (#295).
    //
    // Drop the backend handle immediately — no need to keep it
    // alive past install; the warm cache lives in the OS, not in
    // this process.
    if !no_warmup {
        let asr_dir = models::model_dir(models::ModelKind::Asr)
            .to_string_lossy()
            .into_owned();
        // Honest cost estimate per backend so the user knows what
        // to expect during the pause. CoreML (macOS) pays the ANE
        // compile (~20-30 s); ONNX (Linux/Windows + macOS without
        // `coreml` feature) just loads an ORT session (~500 ms).
        let cost_hint = if cfg!(feature = "coreml") {
            "one-time, ~20-30 s for the ANE compile on first install"
        } else {
            "~500 ms for the ORT session init"
        };
        eprintln!("Warming up ASR backend ({cost_hint})...");
        let t = std::time::Instant::now();
        // Warm-up failures are NON-FATAL (Greptile P1 on #298).
        // All models are already on disk; the install succeeded
        // and the user can still run `kesha audio.ogg`. The first
        // real invocation will pay the cold-start cost we were
        // trying to hide, but that's strictly no-worse than the
        // pre-#298 behavior. Surface the cause on stderr so the
        // user can investigate (typically: ANE permission glitch,
        // CoreML cache directory unwritable, transient ORT init
        // hiccup).
        match backend::create_backend(&asr_dir) {
            Ok(_) => eprintln!("ASR backend warmed up (dt={}ms).", t.elapsed().as_millis()),
            Err(e) => eprintln!(
                "warning: ASR backend warm-up failed ({e}); install \
                 still complete but the first `kesha audio.ogg` will \
                 pay the cold-start cost."
            ),
        }
    }
    // Diarization warm-up (macOS `system_diarize` only). Pre-compile the Sortformer
    // `.mlpackage` to its stable `.mlmodelc` sibling so CoreML's ANE program-compile
    // (~100 s, cached in `com.apple.e5rt.e5bundlecache`) happens HERE rather than on
    // the first `kesha transcribe --speakers`. The e5rt cache is keyed by the compiled
    // bundle's IDENTITY (compile UUID/content), NOT by path — so recreating the
    // `.mlmodelc` at the same path (model-version bump GC, or a user deleting the
    // cache) is still a cache MISS and re-pays the full cold compile (#444 measured
    // 97.7 s on a same-path recompile). The diarize bridge recompiled a throwaway temp
    // model every call before this, so the first real diarize paid ~100 s and tripped
    // the adaptive timeout; after warm-up it loads the stable `.mlmodelc` in ~4 s. Only
    // when this install requested the diarize model and the model is on disk; warm-up
    // failure is NON-FATAL (matches the ASR warm-up above).
    #[cfg(feature = "system_diarize")]
    if diarize && !no_warmup && models::is_cached(models::ModelKind::Diarize) {
        let diarize_pkg = models::model_dir(models::ModelKind::Diarize);
        eprintln!(
            "Warming up diarization model (one-time compile ~1-2 min on first install, ~4 s after)..."
        );
        let t = std::time::Instant::now();
        let result = crate::fluid_stdout::with_silenced_stdout_oneshot(|| {
            fluidaudio_rs::FluidAudio::new()
                .and_then(|fa| fa.compile_diarization_model(&diarize_pkg))
        });
        match result {
            Ok(_) => {
                eprintln!(
                    "Diarization model warmed up (dt={}ms).",
                    t.elapsed().as_millis()
                );
                match models::cleanup_diarize_compiled_sidecars(&diarize_pkg) {
                    Ok(0) => {}
                    Ok(n) => eprintln!("Removed {n} stale diarization sidecar(s)."),
                    Err(e) => eprintln!("warning: diarization sidecar cleanup failed ({e})"),
                }
            }
            Err(e) => eprintln!(
                "warning: diarization warm-up failed ({e}); install still \
                 complete but the first `kesha transcribe --speakers` will \
                 pay the cold-start compile."
            ),
        }
    }
    eprintln!("Install complete.");
    Ok(())
}
