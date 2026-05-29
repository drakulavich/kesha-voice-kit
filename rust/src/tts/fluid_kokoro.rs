//! FluidAudio Kokoro backend — macOS arm64, behind `system_kokoro`.
//!
//! Uses the forked `fluidaudio-rs` crate's native Kokoro binding (in-process),
//! replacing the previous Swift sidecar. Non-Darwin builds stay on the existing
//! ONNX Kokoro implementation.

#![cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]

use anyhow::{Context, Result};
use fluidaudio_rs::FluidAudio;

/// FluidAudio Kokoro native output rate (24 kHz mono, 16-bit PCM). Used to size
/// SSML `<break>` silence buffers when the segment walker stitches audio.
pub const SAMPLE_RATE: u32 = 24_000;

// FluidAudio 0.14.5 voice snapshot. Keep this list in sync with the FluidAudio
// pin in the fluidaudio-rs fork whenever it changes.
const VOICES: &[&str] = &[
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_heart",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
];

pub fn available_voice_ids() -> Vec<String> {
    VOICES.iter().map(|v| format!("en-{v}")).collect()
}

pub fn supports_voice(name: &str) -> bool {
    VOICES.contains(&name)
}

/// Initialize a FluidAudio Kokoro bridge for `voice_id` and run `f` against it
/// with the process's stdout silenced for the whole bridge lifetime (create →
/// call → drop). FluidAudio's CoreML pipeline writes diagnostics to stdout that
/// would corrupt `kesha say`'s WAV byte stream; the oneshot guard restores fd 1
/// on return (#259, mirrors the diarize/ASR guard).
fn with_kokoro<R>(voice_id: &str, f: impl FnOnce(&FluidAudio) -> Result<R>) -> Result<R> {
    crate::fluid_stdout::with_silenced_stdout_oneshot(|| {
        let audio = FluidAudio::new().context("init FluidAudio bridge")?;
        audio
            .init_kokoro(voice_id)
            .context("init FluidAudio Kokoro (downloads the model on first run)")?;
        f(&audio)
    })
}

/// Synthesize `text` with FluidAudio Kokoro (CoreML/ANE) via the native
/// `fluidaudio-rs` binding. `voice_id` is the bare FluidAudio voice (e.g.
/// `am_michael`). Returns a complete WAV byte buffer (24 kHz mono, 16-bit PCM);
/// `tts::say::transcode_to` decodes/re-encodes it for the requested format.
pub fn synthesize(text: &str, voice_id: &str, speed: f32) -> Result<Vec<u8>> {
    if text.is_empty() {
        anyhow::bail!("fluid-kokoro: text is empty");
    }
    with_kokoro(voice_id, |audio| {
        audio
            .synthesize_kokoro(text, voice_id, speed)
            .context("FluidAudio Kokoro synthesis")
    })
}

/// Synthesize one text chunk and return raw PCM f32 samples at [`SAMPLE_RATE`].
///
/// Used by the SSML segment walker (`tts::say::synth_segments_fluid_kokoro`),
/// which decodes/concatenates per-segment audio and interleaves `<break>`
/// silence before encoding once. Empty/whitespace-only text returns an empty
/// buffer (the walker skips it) rather than erroring the whole utterance.
///
/// Each call re-inits the FluidAudio bridge: the dominant SSML case is a single
/// `<prosody>`-wrapped utterance (one call), and the `.mlmodelc` is disk-cached
/// after the first compile so multi-segment re-inits load the compiled model
/// rather than recompiling.
pub fn synthesize_pcm(text: &str, voice_id: &str, speed: f32) -> Result<Vec<f32>> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let wav = with_kokoro(voice_id, |audio| {
        audio
            .synthesize_kokoro(text, voice_id, speed)
            .context("FluidAudio Kokoro synthesis")
    })?;
    wav_to_f32(&wav)
}

/// Decode a FluidAudio Kokoro WAV buffer (24 kHz mono, 16-bit PCM) into f32
/// samples normalized to `[-1.0, 1.0]`. Mirrors the i16→f32 conversion in
/// `tts::say::wav_to_mono_f32` but stays mono-only since FluidAudio always
/// emits a single channel.
fn wav_to_f32(wav: &[u8]) -> Result<Vec<f32>> {
    let reader =
        hound::WavReader::new(std::io::Cursor::new(wav)).context("decode FluidAudio Kokoro WAV")?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .into_samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<std::result::Result<Vec<f32>, _>>()
                .context("read FluidAudio Kokoro PCM samples")?
        }
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .collect::<std::result::Result<Vec<f32>, _>>()
            .context("read FluidAudio Kokoro float samples")?,
    };
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_supported_kesha_voice_ids() {
        let voices = available_voice_ids();
        assert!(voices.contains(&"en-am_michael".to_string()));
        assert!(voices.contains(&"en-af_heart".to_string()));
    }

    #[test]
    fn supports_known_voice() {
        assert!(supports_voice("am_michael"));
        assert!(!supports_voice("nonexistent"));
    }

    #[test]
    #[ignore = "downloads the FluidAudio Kokoro model; run locally on darwin-arm64"]
    fn synthesize_returns_wav() {
        let wav = synthesize("Hello world", "am_michael", 1.0).expect("synth");
        assert!(
            wav.len() > 1000,
            "expected a non-trivial WAV, got {}",
            wav.len()
        );
        assert_eq!(&wav[..4], b"RIFF", "expected a RIFF/WAVE header");
    }
}
