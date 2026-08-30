use anyhow::Result;

use crate::{backend, models};

#[derive(clap::Args)]
pub struct InstallArgs {
    /// Re-download even if cached
    #[arg(long)]
    pub no_cache: bool,
    /// Install TTS models for these languages (space-separated, e.g.
    /// `--tts en ru`). Bare `--tts` installs English only. Codes are
    /// validated against this build's supported set.
    #[cfg(feature = "tts")]
    #[arg(long, num_args = 0.., value_name = "LANG", default_missing_value = "en")]
    pub tts: Vec<String>,
    /// Also install Silero VAD (~2.3MB) for long-audio preprocessing.
    #[arg(long)]
    pub vad: bool,
    /// Also install the Sortformer streaming-diarization model (~245MB,
    /// darwin-arm64 only, #199).
    #[cfg(feature = "system_diarize")]
    #[arg(long)]
    pub diarize: bool,
    /// Skip the ASR-backend warm-up step at the end of install. On macOS
    /// (CoreML) the warm-up triggers the ~20-30 s Apple Neural Engine
    /// model-compile so the first `kesha audio.ogg` invocation is fast.
    /// On the ONNX path (Linux/Windows) warm-up is ~500 ms — still worth
    /// running since it surfaces missing-dep crashes at install time.
    /// Use this flag in scripted installs where the cold-start cost
    /// belongs on the first real run, or to debug install-time issues
    /// without the backend in the loop.
    #[arg(long = "no-warmup")]
    pub no_warmup: bool,
}

pub fn run(args: InstallArgs) -> Result<()> {
    let InstallArgs {
        no_cache,
        #[cfg(feature = "tts")]
            tts: tts_langs,
        vad,
        #[cfg(feature = "system_diarize")]
        diarize,
        no_warmup,
    } = args;
    // Emit once at the top; push-down to each download_* would hide a stderr write behind Ok(()).
    models::init_mirror_logging();
    models::install(no_cache)?;
    #[cfg(feature = "tts")]
    if !tts_langs.is_empty() {
        let refs: Vec<&str> = tts_langs.iter().map(String::as_str).collect();
        models::validate_tts_langs(&refs)?;
        models::download_tts(&refs, no_cache)?;
        eprintln!("TTS models installed ({}).", tts_langs.join(", "));
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
    // Pre-pay ANE model-compile (~20-30 s CoreML) / ORT session init (~500 ms) here so the
    // first real `kesha audio.ogg` is fast. CoreML cache is keyed by (model bytes, signing
    // identity) and survives process exit; survives re-runs until next `kesha install` re-signs (#295).
    if !no_warmup {
        let asr_dir = models::model_dir(models::ModelKind::Asr)?;
        let cost_hint = if cfg!(feature = "coreml") {
            "one-time, ~20-30 s for the ANE compile on first install"
        } else {
            "~500 ms for the ORT session init"
        };
        eprintln!("Warming up ASR backend ({cost_hint})...");
        let t = std::time::Instant::now();
        // Non-fatal: install already succeeded; first real run pays cold-start instead (#298).
        match backend::create_backend(&asr_dir) {
            Ok(_) => eprintln!("ASR backend warmed up (dt={}ms).", t.elapsed().as_millis()),
            Err(e) => eprintln!(
                "warning: ASR backend warm-up failed ({e}); install \
                 still complete but the first `kesha audio.ogg` will \
                 pay the cold-start cost."
            ),
        }
    }
    // Pre-compile Sortformer .mlpackage → stable .mlmodelc so ANE program-compile (~100 s)
    // happens here, not on first `kesha transcribe --speakers`. e5rt cache is keyed by bundle
    // IDENTITY, not path — same-path recompile is still a full miss (#444, 97.7 s measured).
    // Non-fatal: matches ASR warm-up above.
    #[cfg(feature = "system_diarize")]
    if diarize && !no_warmup && models::is_cached(models::ModelKind::Diarize) {
        let diarize_pkg = models::model_dir(models::ModelKind::Diarize)?;
        let diarize_loc = models::fluidaudio_diarize_location()?;
        eprintln!(
            "Warming up diarization model (one-time compile ~1-2 min on first install, ~4 s after)..."
        );
        let t = std::time::Instant::now();
        let result = crate::fluid_stdout::with_silenced_stdout_oneshot(|| {
            models::fluidaudio_bridge(&diarize_loc)
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
