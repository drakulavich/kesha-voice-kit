//! End-to-end regression guard for `kesha say --rate` on the CoreML / ANE
//! Kokoro path (#475).
//!
//! Before the FluidAudio 0.14.7 `KokoroAneManager` migration, `--rate` was
//! silently ignored on darwin-arm64 `en-*` voices: every utterance came out at
//! 1.0× regardless of the flag. This test synthesizes the SAME text with the
//! male brand-default voice `en-am_michael` at `--rate 1.0` and `--rate 1.5`,
//! decodes both WAVs, and asserts:
//!
//!   1. `duration(1.5)` is within ±12% of `duration(1.0) / 1.5` — i.e. the
//!      faster rate actually produced shorter audio (the #475 fix), and
//!   2. the two outputs differ byte-for-byte (a no-op `--rate` would emit
//!      identical bytes), and
//!   3. `en-am_michael` at 1.0× is non-silent — the male catalog default is
//!      preserved (CLAUDE.md "DEFAULT TTS VOICES MUST BE MALE").
//!
//! Gating mirrors `diarize_e2e.rs`: the file only COMPILES on darwin-arm64
//! builds with `system_kokoro` (the FluidAudio ANE Kokoro feature), and SKIPS
//! at runtime — without failing — when the engine binary or the FluidAudio ANE
//! Kokoro model + `am_michael` voice pack aren't staged locally. PR CI never
//! builds `system_kokoro` for the nextest run and never downloads the ANE
//! model, so this is a local / release-smoke gate. Run it with:
//!
//! ```sh
//! cd rust && cargo nextest run --features \
//!   coreml,tts,system_tts,system_kokoro,system_diarize,system_text_lang \
//!   kokoro_rate_changes_duration --no-capture
//! ```
//!
//! (Requires `kesha install --tts` to have staged the ANE Kokoro model + the
//! `am_michael` voice pack into `~/.cache/fluidaudio/Models/kokoro-82m-coreml/ANE/`.)

#![cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

/// True when FluidAudio's ANE Kokoro model graph + the `am_michael` voice pack
/// are staged locally. Without both, `kesha say` on the ANE path would try to
/// download (and `kesha install --tts` is the explicit-install contract), so we
/// skip rather than fail. The model graph is a `.mlmodelc` bundle; the voice
/// pack is the flat `<voice>.bin` `stage_ane_kokoro_voices` writes.
fn ane_kokoro_ready() -> bool {
    let ane = kesha_engine::models::fluidaudio_ane_kokoro_dir();
    let model_graph = ane.join("KokoroVocoder.mlmodelc");
    let voice = ane.join("am_michael.bin");
    model_graph.exists() && voice.exists()
}

/// Synthesize `text` with `voice` at `rate` into `out` via the real engine
/// binary. Returns `false` (skip signal) when synthesis fails for a missing
/// prerequisite, `true` on success; panics on an unexpected failure.
fn say_rate(exe: &Path, text: &str, voice: &str, rate: &str, out: &Path) -> bool {
    let result = Command::new(exe)
        .args([
            "say",
            "--voice",
            voice,
            "--rate",
            rate,
            "--out",
            out.to_str().unwrap(),
        ])
        .arg(text)
        .output()
        .expect("spawn kesha-engine say");
    if result.status.success() {
        return true;
    }
    let stderr = String::from_utf8_lossy(&result.stderr);
    // Missing-model / missing-voice failures are skips, not regressions —
    // mirrors diarize_e2e.rs's prerequisite handling. `ane_kokoro_ready()`
    // already confirmed the model + voice exist before we synthesized, so we
    // match only the specific "models not installed" prerequisite messages the
    // engine emits — NOT a bare "download" substring, which would also swallow
    // a genuine synthesis regression whose error happens to mention downloads.
    if stderr.contains("install --tts")
        || stderr.contains("not installed")
        || stderr.contains("voice pack")
    {
        eprintln!(
            "skipping: ANE Kokoro prerequisite missing (run `kesha install --tts`):\n{stderr}"
        );
        return false;
    }
    panic!("kesha-engine say --rate {rate} failed unexpectedly: {stderr}");
}

/// Decode a mono WAV (FluidAudio ANE emits 24 kHz 16-bit PCM) and return
/// `(duration_seconds, samples)`. Generic over sample format so an upstream
/// switch to float doesn't silently break the math.
fn wav_duration_and_samples(path: &Path) -> (f64, Vec<f32>) {
    let reader = hound::WavReader::open(path).expect("open say output wav");
    let spec = reader.spec();
    assert_eq!(
        spec.channels, 1,
        "expected mono WAV from the ANE Kokoro path"
    );
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .into_samples::<i32>()
                .map(|s| s.expect("read int sample") as f32 / max)
                .collect()
        }
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .map(|s| s.expect("read f32 sample"))
            .collect(),
    };
    let dur = samples.len() as f64 / f64::from(spec.sample_rate);
    (dur, samples)
}

/// Peak amplitude of a sample buffer — used as a cheap non-silence check.
fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0_f32, |m, &s| m.max(s.abs()))
}

#[test]
fn kokoro_rate_changes_duration() {
    let exe = PathBuf::from(common::engine_bin());
    if !exe.exists() {
        eprintln!("skipping: engine binary not found at {}", exe.display());
        return;
    }
    if !ane_kokoro_ready() {
        eprintln!(
            "skipping: FluidAudio ANE Kokoro model + am_michael voice pack not staged \
             (run `kesha install --tts`)"
        );
        return;
    }

    let tmp = tempfile::Builder::new()
        .prefix("kesha-kokoro-rate-")
        .tempdir()
        .unwrap();
    let slow = tmp.path().join("rate-1.0.wav");
    let fast = tmp.path().join("rate-1.5.wav");

    // Same text, same male default voice, only `--rate` differs. A longer
    // sentence makes the duration ratio statistically robust against the
    // model's fixed leading/trailing silence padding.
    let text = "The quick brown fox jumps over the lazy dog near the riverbank at noon.";
    let voice = "en-am_michael";

    if !say_rate(&exe, text, voice, "1.0", &slow) {
        return; // prerequisite missing — skip cleanly
    }
    if !say_rate(&exe, text, voice, "1.5", &fast) {
        return;
    }

    let (dur_slow, samples_slow) = wav_duration_and_samples(&slow);
    let (dur_fast, samples_fast) = wav_duration_and_samples(&fast);
    let ratio = dur_slow / dur_fast;
    eprintln!(
        "kokoro_rate_changes_duration: rate=1.0 -> {dur_slow:.3}s, \
         rate=1.5 -> {dur_fast:.3}s, ratio(1.0/1.5)={ratio:.3} (expected ~1.5)"
    );

    // (3) Male brand default produces audible audio at 1.0×.
    assert!(
        peak(&samples_slow) > 0.01,
        "en-am_michael at rate 1.0 produced (near-)silent audio (peak {})",
        peak(&samples_slow)
    );

    // (2) `--rate` is honored, not silently dropped: a no-op rate would emit
    // identical-length audio. We reuse the already-decoded sample buffers
    // instead of re-reading both WAVs from disk — different durations imply
    // different data-chunk sizes, so this is the cheap in-memory corollary of
    // the duration-ratio assertion below.
    assert_ne!(
        samples_slow.len(),
        samples_fast.len(),
        "rate 1.0 and rate 1.5 produced equal-length audio — --rate was ignored (#475 regression)"
    );

    // (1) The objective #475 guard: 1.5× must produce ~1.5× shorter audio.
    // `duration(1.5)` should sit within ±12% of `duration(1.0) / 1.5`.
    let expected_fast = dur_slow / 1.5;
    let tol = 0.12;
    let lo = expected_fast * (1.0 - tol);
    let hi = expected_fast * (1.0 + tol);
    assert!(
        (lo..=hi).contains(&dur_fast),
        "rate 1.5 duration {dur_fast:.3}s outside ±{:.0}% of expected {expected_fast:.3}s \
         (range {lo:.3}..={hi:.3}); rate 1.0 was {dur_slow:.3}s. --rate not honored on \
         the CoreML Kokoro path (#475).",
        tol * 100.0
    );
}

/// Synthesize SSML `markup` with `voice` into `out` via the real engine binary
/// (`--ssml`). Same skip/panic contract as [`say_rate`]: a missing-prerequisite
/// failure returns `false` (skip), success returns `true`, anything else panics.
fn say_ssml(exe: &Path, markup: &str, voice: &str, out: &Path) -> bool {
    let result = Command::new(exe)
        .args([
            "say",
            "--voice",
            voice,
            "--ssml",
            "--out",
            out.to_str().unwrap(),
        ])
        .arg(markup)
        .output()
        .expect("spawn kesha-engine say --ssml");
    if result.status.success() {
        return true;
    }
    let stderr = String::from_utf8_lossy(&result.stderr);
    if stderr.contains("install --tts")
        || stderr.contains("not installed")
        || stderr.contains("voice pack")
    {
        eprintln!(
            "skipping: ANE Kokoro prerequisite missing (run `kesha install --tts`):\n{stderr}"
        );
        return false;
    }
    panic!("kesha-engine say --ssml failed unexpectedly: {stderr}");
}

#[test]
fn kokoro_ssml_prosody_rate_changes_duration() {
    // #481: SSML `<prosody rate="x-fast">` on the FluidAudio ANE Kokoro path
    // must SPEED UP synthesis (threaded into the model-native speed input), not
    // error out ("SSML is not yet supported with FluidAudio Kokoro voices") and
    // not be a silent no-op. x-fast maps to 1.5×, so the prosody-wrapped
    // utterance should be ~1.5× shorter than the same text synthesized as plain
    // text at 1.0×. Both are single synth calls, so FluidAudio's fixed
    // leading/trailing silence padding cancels in the ratio.
    let exe = PathBuf::from(common::engine_bin());
    if !exe.exists() {
        eprintln!("skipping: engine binary not found at {}", exe.display());
        return;
    }
    if !ane_kokoro_ready() {
        eprintln!(
            "skipping: FluidAudio ANE Kokoro model + am_michael voice pack not staged \
             (run `kesha install --tts`)"
        );
        return;
    }

    let tmp = tempfile::Builder::new()
        .prefix("kesha-kokoro-ssml-")
        .tempdir()
        .unwrap();
    let plain = tmp.path().join("plain-1.0.wav");
    let xfast = tmp.path().join("ssml-xfast.wav");

    let text = "The quick brown fox jumps over the lazy dog near the riverbank at noon.";
    let voice = "en-am_michael";
    let ssml = format!("<speak><prosody rate=\"x-fast\">{text}</prosody></speak>");

    if !say_rate(&exe, text, voice, "1.0", &plain) {
        return; // prerequisite missing — skip cleanly
    }
    if !say_ssml(&exe, &ssml, voice, &xfast) {
        return;
    }

    // `samples_plain` is unused — the existing `kokoro_rate_changes_duration`
    // already guards am_michael non-silence at 1.0×; here we only need the
    // plain-text duration as the prosody baseline.
    let (dur_plain, _) = wav_duration_and_samples(&plain);
    let (dur_xfast, samples_xfast) = wav_duration_and_samples(&xfast);
    eprintln!(
        "kokoro_ssml_prosody_rate_changes_duration: plain@1.0 -> {dur_plain:.3}s, \
         x-fast -> {dur_xfast:.3}s, ratio(plain/xfast)={:.3} (expected ~1.5)",
        dur_plain / dur_xfast
    );

    // Prosody output is audible — not an empty/silent buffer from a swallowed
    // segment.
    assert!(
        peak(&samples_xfast) > 0.01,
        "x-fast prosody produced (near-)silent audio (peak {})",
        peak(&samples_xfast)
    );

    // The #481 guard: prosody must shorten the audio, and by ~1.5×. A rejected
    // or no-op `<prosody rate>` would either fail synthesis (caught above) or
    // emit plain-duration audio.
    assert!(
        dur_xfast < dur_plain,
        "SSML <prosody rate=\"x-fast\"> did not shorten audio ({dur_xfast:.3}s vs plain \
         {dur_plain:.3}s) — prosody ignored or rejected (#481)"
    );
    let expected = dur_plain / 1.5;
    let tol = 0.12;
    let lo = expected * (1.0 - tol);
    let hi = expected * (1.0 + tol);
    assert!(
        (lo..=hi).contains(&dur_xfast),
        "x-fast duration {dur_xfast:.3}s outside ±{:.0}% of expected {expected:.3}s \
         (range {lo:.3}..={hi:.3}); plain was {dur_plain:.3}s. <prosody rate> not threaded \
         into the FluidAudio Kokoro speed input (#481).",
        tol * 100.0
    );
}
