//! Stable, user-visible error codes for every user-facing failure path.
//!
//! A leaf failure attaches a code via [`coded_bail!`] or [`CodedContext::coded`].
//! The code rides in the `anyhow` chain inside a [`CodedError`]; the top-level
//! [`report`] walks the chain, prints `error [CODE]: <message>` to stderr, and
//! returns the process exit code. See
//! `docs/superpowers/specs/2026-05-30-structured-error-taxonomy-design.md`.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InputNotFound,
    BadAudio,
    ModelMissing,
    ModelDownload,
    CacheCorrupt,
    ModelLoad,
    UnsupportedPlatform,
    SidecarMissing,
    NoBackend,
    TextEmpty,
    TextTooLong,
    VoiceUnknown,
    SsmlInvalid,
    SsmlUnsupported,
    ScriptUnsupported,
    TranscribeFailed,
    DiarizeTimeout,
    InvalidArg,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Input,
    Model,
    Platform,
    Tts,
    Transcribe,
    Internal,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 19] = [
        ErrorCode::InputNotFound,
        ErrorCode::BadAudio,
        ErrorCode::ModelMissing,
        ErrorCode::ModelDownload,
        ErrorCode::CacheCorrupt,
        ErrorCode::ModelLoad,
        ErrorCode::UnsupportedPlatform,
        ErrorCode::SidecarMissing,
        ErrorCode::NoBackend,
        ErrorCode::TextEmpty,
        ErrorCode::TextTooLong,
        ErrorCode::VoiceUnknown,
        ErrorCode::SsmlInvalid,
        ErrorCode::SsmlUnsupported,
        ErrorCode::ScriptUnsupported,
        ErrorCode::TranscribeFailed,
        ErrorCode::DiarizeTimeout,
        ErrorCode::InvalidArg,
        ErrorCode::Internal,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InputNotFound => "E_INPUT_NOT_FOUND",
            ErrorCode::BadAudio => "E_BAD_AUDIO",
            ErrorCode::ModelMissing => "E_MODEL_MISSING",
            ErrorCode::ModelDownload => "E_MODEL_DOWNLOAD",
            ErrorCode::CacheCorrupt => "E_CACHE_CORRUPT",
            ErrorCode::ModelLoad => "E_MODEL_LOAD",
            ErrorCode::UnsupportedPlatform => "E_UNSUPPORTED_PLATFORM",
            ErrorCode::SidecarMissing => "E_SIDECAR_MISSING",
            ErrorCode::NoBackend => "E_NO_BACKEND",
            ErrorCode::TextEmpty => "E_TEXT_EMPTY",
            ErrorCode::TextTooLong => "E_TEXT_TOO_LONG",
            ErrorCode::VoiceUnknown => "E_VOICE_UNKNOWN",
            ErrorCode::SsmlInvalid => "E_SSML_INVALID",
            ErrorCode::SsmlUnsupported => "E_SSML_UNSUPPORTED",
            ErrorCode::ScriptUnsupported => "E_SCRIPT_UNSUPPORTED",
            ErrorCode::TranscribeFailed => "E_TRANSCRIBE_FAILED",
            ErrorCode::DiarizeTimeout => "E_DIARIZE_TIMEOUT",
            ErrorCode::InvalidArg => "E_INVALID_ARG",
            ErrorCode::Internal => "E_INTERNAL",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            ErrorCode::InputNotFound => "Input file not found",
            ErrorCode::BadAudio => "Unreadable or unsupported audio",
            ErrorCode::ModelMissing => "Model or voice not installed",
            ErrorCode::ModelDownload => "Model download failed",
            ErrorCode::CacheCorrupt => "Cached model failed verification",
            ErrorCode::ModelLoad => "Model failed to load",
            ErrorCode::UnsupportedPlatform => "Feature unsupported on this platform",
            ErrorCode::SidecarMissing => "Helper sidecar missing or failed",
            ErrorCode::NoBackend => "No ASR backend compiled in",
            ErrorCode::TextEmpty => "Empty synthesis text",
            ErrorCode::TextTooLong => "Synthesis text too long",
            ErrorCode::VoiceUnknown => "Unknown voice id",
            ErrorCode::SsmlInvalid => "Malformed SSML",
            ErrorCode::SsmlUnsupported => "SSML not supported for this engine",
            ErrorCode::ScriptUnsupported => "Text script not supported for this voice",
            ErrorCode::TranscribeFailed => "Transcription failed",
            ErrorCode::DiarizeTimeout => "Speaker diarization timed out",
            ErrorCode::InvalidArg => "Invalid command-line argument",
            ErrorCode::Internal => "Unexpected internal error",
        }
    }

    pub fn category(self) -> Category {
        match self {
            ErrorCode::InputNotFound | ErrorCode::BadAudio | ErrorCode::InvalidArg => {
                Category::Input
            }
            ErrorCode::ModelMissing
            | ErrorCode::ModelDownload
            | ErrorCode::CacheCorrupt
            | ErrorCode::ModelLoad => Category::Model,
            ErrorCode::UnsupportedPlatform | ErrorCode::SidecarMissing | ErrorCode::NoBackend => {
                Category::Platform
            }
            ErrorCode::TextEmpty
            | ErrorCode::TextTooLong
            | ErrorCode::VoiceUnknown
            | ErrorCode::SsmlInvalid
            | ErrorCode::SsmlUnsupported
            | ErrorCode::ScriptUnsupported => Category::Tts,
            ErrorCode::TranscribeFailed | ErrorCode::DiarizeTimeout => Category::Transcribe,
            ErrorCode::Internal => Category::Internal,
        }
    }

    pub fn retryable(self) -> bool {
        matches!(self, ErrorCode::ModelDownload | ErrorCode::DiarizeTimeout)
    }
}

/// An error carrying a stable [`ErrorCode`] plus a human message. Sits as a
/// leaf in the `anyhow` chain so [`code_of`] can recover the code.
#[derive(Debug)]
pub struct CodedError {
    pub code: ErrorCode,
    pub message: String,
}

impl std::fmt::Display for CodedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CodedError {}

/// Construct and return a coded error. Drop-in for `anyhow::bail!`.
#[macro_export]
macro_rules! coded_bail {
    ($code:expr, $($arg:tt)*) => {
        return ::core::result::Result::Err(::anyhow::Error::new($crate::errors::CodedError {
            code: $code,
            message: ::std::format!($($arg)*),
        }))
    };
}

/// Attach a code to a `Result`, snapshotting the existing chain message.
pub trait CodedContext<T> {
    fn coded(self, code: ErrorCode) -> anyhow::Result<T>;
}

impl<T, E> CodedContext<T> for Result<T, E>
where
    E: Into<anyhow::Error>,
{
    fn coded(self, code: ErrorCode) -> anyhow::Result<T> {
        self.map_err(|e| {
            let e: anyhow::Error = e.into();
            anyhow::Error::new(CodedError {
                code,
                message: format!("{e:#}"),
            })
        })
    }
}

/// Recover the code from anywhere in the chain; `Internal` if none.
pub fn code_of(err: &anyhow::Error) -> ErrorCode {
    err.chain()
        .find_map(|e| e.downcast_ref::<CodedError>().map(|c| c.code))
        .unwrap_or(ErrorCode::Internal)
}

/// Print `error [CODE]: <message>` to stderr and return the process exit code.
/// Exit code stays 1 (runtime failure) — unchanged from prior behavior.
pub fn report(err: &anyhow::Error) -> i32 {
    let code = code_of(err);
    eprintln!("error [{}]: {:#}", code.as_str(), err);
    1
}

#[derive(Serialize)]
struct CodeEntry {
    code: &'static str,
    title: &'static str,
    category: Category,
    retryable: bool,
}

/// JSON array of every error code, for `--error-codes-json`, docs drift tests,
/// and `kesha doctor`.
pub fn error_codes_json() -> String {
    let entries: Vec<CodeEntry> = ErrorCode::ALL
        .iter()
        .map(|&c| CodeEntry {
            code: c.as_str(),
            title: c.title(),
            category: c.category(),
            retryable: c.retryable(),
        })
        .collect();
    serde_json::to_string(&entries).expect("error-codes serialize")
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Context as _;

    #[test]
    fn code_strings_are_stable_unique_and_prefixed() {
        let all = ErrorCode::ALL;
        let mut seen = std::collections::HashSet::new();
        for c in all {
            let s = c.as_str();
            assert!(s.starts_with("E_"), "{s} must start with E_");
            assert!(seen.insert(s), "duplicate code string {s}");
            assert!(!c.title().is_empty(), "{s} missing title");
        }
    }

    #[test]
    fn category_and_retryable_are_total_and_consistent() {
        // Exercises category() / retryable() (and the Category enum) for every
        // code so the metadata surface stays total. Only download/timeout codes
        // are retryable.
        for c in ErrorCode::ALL {
            // category() is total — a missing arm would not compile, but assert
            // the serde rename round-trips to a non-empty lowercase tag.
            let tag = serde_json::to_string(&c.category()).expect("category serializes");
            assert!(tag.len() > 2, "{} category serialized empty", c.as_str());
            let expected_retryable =
                matches!(c, ErrorCode::ModelDownload | ErrorCode::DiarizeTimeout);
            assert_eq!(
                c.retryable(),
                expected_retryable,
                "{} retryable mismatch",
                c.as_str()
            );
        }
    }

    #[test]
    fn coded_bail_attaches_code_findable_in_chain() {
        fn leaf() -> anyhow::Result<()> {
            coded_bail!(
                ErrorCode::ModelMissing,
                "voice '{}' not installed",
                "ru-vosk-m02"
            );
        }
        let err = leaf().unwrap_err().context("while loading voice");
        assert_eq!(code_of(&err), ErrorCode::ModelMissing);
    }

    #[test]
    fn coded_extension_snapshots_message_and_code() {
        let res: anyhow::Result<()> = Err(anyhow::anyhow!("boom"))
            .context("decode error in: /Users/alice/secret.wav")
            .coded(ErrorCode::BadAudio);
        let err = res.unwrap_err();
        assert_eq!(code_of(&err), ErrorCode::BadAudio);
        let coded = err.downcast_ref::<CodedError>().expect("is CodedError");
        assert!(coded.message.contains("decode error"));
    }

    #[test]
    fn code_of_falls_back_to_internal_for_uncoded() {
        let err = anyhow::anyhow!("plain error");
        assert_eq!(code_of(&err), ErrorCode::Internal);
    }

    #[test]
    fn report_returns_runtime_exit_code() {
        // report() prints `error [CODE]: <msg>` to stderr and returns the
        // process exit code, which stays 1 for any runtime failure.
        let coded: anyhow::Result<()> =
            Err(anyhow::anyhow!("boom")).coded(ErrorCode::TranscribeFailed);
        assert_eq!(report(&coded.unwrap_err()), 1);
        let plain = anyhow::anyhow!("plain");
        assert_eq!(report(&plain), 1);
    }

    #[test]
    fn error_codes_json_covers_all_variants() {
        let json = error_codes_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let arr = parsed.as_array().unwrap();
        assert_eq!(arr.len(), ErrorCode::ALL.len());
        for c in ErrorCode::ALL {
            assert!(
                arr.iter().any(|e| e["code"] == c.as_str()),
                "{} missing from --error-codes-json",
                c.as_str()
            );
        }
        let model_missing = arr.iter().find(|e| e["code"] == "E_MODEL_MISSING").unwrap();
        assert_eq!(model_missing["category"], "model");
        assert_eq!(model_missing["retryable"], false);
        assert!(model_missing["title"].is_string());
    }
}
