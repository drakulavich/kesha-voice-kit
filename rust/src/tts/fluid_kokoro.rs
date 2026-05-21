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

/// Synthesize `text` with FluidAudio Kokoro (CoreML/ANE) via the native
/// `fluidaudio-rs` binding. `voice_id` is the bare FluidAudio voice (e.g.
/// `am_michael`). Returns a complete WAV byte buffer (24 kHz mono, 16-bit PCM);
/// `tts::say::transcode_to` decodes/re-encodes it for the requested format.
pub fn synthesize(text: &str, voice_id: &str, speed: f32) -> Result<Vec<u8>> {
    if text.is_empty() {
        anyhow::bail!("fluid-kokoro: text is empty");
    }
    // `kesha say` writes the WAV bytes to stdout; silence FluidAudio's CoreML
    // stdout noise for the whole FluidAudio lifetime so it can't corrupt the
    // audio stream (#259, mirrors the diarize/ASR guard).
    crate::fluid_stdout::with_silenced_stdout_oneshot(|| {
        let audio = FluidAudio::new().context("init FluidAudio bridge")?;
        audio
            .init_kokoro(voice_id)
            .context("init FluidAudio Kokoro (downloads the model on first run)")?;
        audio
            .synthesize_kokoro(text, voice_id, speed)
            .context("FluidAudio Kokoro synthesis")
    })
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
