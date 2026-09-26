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
pub mod script;
pub mod seam;
pub mod sessions;
pub mod ssml;
mod token;
pub mod tokenizer;
pub mod voices;
pub mod vosk;
pub mod warn;
pub mod wav;

pub use encode::OutputFormat;
pub use say::say;

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

/// A model file that is present but will not load; `kesha install --tts` re-verifies and re-fetches it.
pub(crate) fn model_load_failed(
    model: &str,
    path: &Path,
    cause: impl std::fmt::Display,
) -> anyhow::Error {
    anyhow::Error::new(crate::errors::CodedError {
        code: crate::errors::ErrorCode::ModelLoad,
        message: format!(
            "{model} model {} failed to load ({cause}); reinstall it: kesha install --tts",
            path.display()
        ),
    })
}

/// Only the file step is `E_MODEL_LOAD`: a builder failure is the ONNX Runtime, which reinstalling a model cannot fix.
pub(crate) fn open_session(
    model: &str,
    path: &Path,
    builder: ort::Result<ort::session::builder::SessionBuilder>,
) -> anyhow::Result<ort::session::Session> {
    let mut builder = builder
        .map_err(|e| anyhow::anyhow!("ONNX Runtime could not create a session for {model}: {e}"))?;
    match builder.commit_from_file(path) {
        Ok(session) => Ok(session),
        // An absent `--model` path is not a load failure; tts_smoke pins its exit 4.
        Err(e) if !path.exists() => Err(e.into()),
        Err(e) => Err(model_load_failed(model, path, e)),
    }
}

impl TtsError {
    /// Keeps a code attached deeper in `e` instead of collapsing it to `E_INTERNAL`.
    pub(crate) fn from_engine(stage: &str, e: anyhow::Error) -> Self {
        match crate::errors::code_of(&e) {
            crate::errors::ErrorCode::Internal => {
                TtsError::SynthesisFailed(format!("{stage}: {e}"))
            }
            code => TtsError::Coded {
                code,
                message: format!("{e:#}"),
            },
        }
    }

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
        /// Public voice id, so the script gate and its diagnostics can name it.
        voice_id: &'a str,
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
        /// Public voice id, so the script gate and its diagnostics can name it.
        voice_id: &'a str,
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
    fn a_session_builder_failure_is_not_blamed_on_the_model_file() {
        let model = tempfile::NamedTempFile::new().unwrap();
        let err = open_session(
            "Kokoro",
            model.path(),
            Err(ort::Error::new("runtime unavailable")),
        )
        .expect_err("a builder failure must fail the load");
        assert_eq!(crate::errors::code_of(&err), ErrorCode::Internal, "{err:#}");
        assert!(!format!("{err:#}").contains("reinstall"), "{err:#}");
    }

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
