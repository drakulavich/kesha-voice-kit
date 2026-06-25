//! Text-to-speech façade.

use std::path::Path;

pub mod charsiu;
pub mod en;
pub mod encode;
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub mod fluid_kokoro;
pub mod g2p;
pub mod kokoro;
pub mod normalize;
pub mod ru;
pub mod say;
pub mod sessions;
pub mod ssml;
pub mod tokenizer;
pub mod voices;
pub mod vosk;
pub mod warn;
pub mod wav;

pub use encode::OutputFormat;
pub use say::{say, synth_segments_kokoro_with, synth_segments_vosk_with};

#[cfg(all(feature = "system_tts", target_os = "macos"))]
pub mod avspeech;

/// Soft limit on input text length. Rejects absurdly long inputs that would
/// spend minutes on synthesis with poor quality.
pub const MAX_TEXT_CHARS: usize = 5000;

/// Only ru-vosk-* voices honor `+`; every other synth path strips it (callers decide whether to warn first).
pub(crate) fn strip_emphasis_markers(content: String) -> String {
    if content.contains('+') {
        content.replace('+', "")
    } else {
        content
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TtsError {
    #[error("text is empty")]
    EmptyText,
    #[error("text exceeds {max} chars ({actual})")]
    TextTooLong { max: usize, actual: usize },
    #[error("synthesis failed: {0}")]
    SynthesisFailed(String),
    /// A synthesis failure that carries a precise taxonomy code recovered from
    /// the underlying engine error (e.g. SSML parse failures preserve their
    /// `SsmlInvalid` code instead of collapsing to `Internal`).
    #[error("{message}")]
    Coded {
        code: crate::errors::ErrorCode,
        message: String,
    },
}

impl TtsError {
    /// Stable taxonomy code for this synthesis failure.
    pub fn code(&self) -> crate::errors::ErrorCode {
        use crate::errors::ErrorCode;
        match self {
            TtsError::EmptyText => ErrorCode::TextEmpty,
            TtsError::TextTooLong { .. } => ErrorCode::TextTooLong,
            TtsError::SynthesisFailed(_) => ErrorCode::Internal,
            TtsError::Coded { code, .. } => *code,
        }
    }
}

/// Which TTS engine to run. Voice ids determine this via `voices::resolve_voice`.
pub enum EngineChoice<'a> {
    Kokoro {
        model_path: &'a Path,
        voice_path: &'a Path,
        speed: f32,
    },
    /// Kokoro via FluidAudio CoreML sidecar on darwin-arm64.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    FluidKokoro { voice_id: &'a str, speed: f32 },
    /// macOS AVSpeechSynthesizer via the Swift sidecar (#141).
    /// `speed` is the user-facing multiplier (0.5–2.0); mapped onto AVSpeech 0.0–1.0 inside the sidecar (#546).
    #[cfg(all(feature = "system_tts", target_os = "macos"))]
    AVSpeech { voice_id: &'a str, speed: f32 },
    /// Vosk-TTS Russian: G2P happens inside vosk, not in the caller.
    Vosk {
        model_dir: &'a Path,
        speaker_id: u32,
        /// Speaking rate (1.0 = model default); passed to vosk's `speech_rate`.
        speed: f32,
    },
}

pub struct SayOptions<'a> {
    pub text: &'a str,
    /// espeak language code, e.g. `en-us`, `ru`.
    pub lang: &'a str,
    pub engine: EngineChoice<'a>,
    /// When true, `text` is parsed as SSML (issue #122). `<break>` tags yield
    /// silence of the declared duration; unknown tags are stripped with a warning.
    pub ssml: bool,
    /// Wire format for returned bytes; defaults to `Wav` for back-compat (#223).
    pub format: OutputFormat,
    /// Auto-expand all-uppercase acronyms before synth: Cyrillic on `ru-vosk-*` (#232), Latin on `en-*` (#244).
    /// `<say-as interpret-as="characters">` is always honored regardless of this flag. No effect for `macos-*`.
    pub expand_abbrev: bool,
}

#[cfg(test)]
mod code_tests {
    use super::*;
    use crate::errors::ErrorCode;

    #[test]
    fn tts_error_maps_to_codes() {
        assert_eq!(TtsError::EmptyText.code(), ErrorCode::TextEmpty);
        assert_eq!(
            TtsError::TextTooLong {
                max: 5000,
                actual: 6000
            }
            .code(),
            ErrorCode::TextTooLong
        );
        assert_eq!(
            TtsError::SynthesisFailed("x".into()).code(),
            ErrorCode::Internal
        );
        assert_eq!(
            TtsError::Coded {
                code: ErrorCode::SsmlInvalid,
                message: "ssml: bad".into()
            }
            .code(),
            ErrorCode::SsmlInvalid
        );
    }
}
