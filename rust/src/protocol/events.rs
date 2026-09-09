//! One NDJSON event per stderr line. Protocol 4 has no prose form.

use crate::errors::ErrorCode;
use serde::Serialize;
use std::io::Write;

pub const W_VAD_NOT_INSTALLED: &str = "W_VAD_NOT_INSTALLED";
pub const W_VAD_NO_SPEECH: &str = "W_VAD_NO_SPEECH";
pub const W_RECOVERY_AUDIO: &str = "W_RECOVERY_AUDIO";
pub const W_MIC_DROPPED: &str = "W_MIC_DROPPED";
pub const W_INSTALL: &str = "W_INSTALL";
pub const W_DOWNLOAD: &str = "W_DOWNLOAD";
pub const W_GENERIC: &str = "W_GENERIC";

/// The published warning taxonomy `describe` serves; the `W_*` constants above are its call-site names.
pub const WARN_CODES: &[(&str, &str)] = &[
    (
        W_VAD_NOT_INSTALLED,
        "Voice activity detection not installed",
    ),
    (
        W_VAD_NO_SPEECH,
        "No speech found by voice activity detection",
    ),
    (W_RECOVERY_AUDIO, "Interrupted recording was recovered"),
    (W_MIC_DROPPED, "Microphone input was dropped"),
    (W_INSTALL, "Install step reported a problem"),
    (W_DOWNLOAD, "A model download failed"),
    (W_GENERIC, "Unclassified engine warning"),
];

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Event<'a> {
    Progress {
        #[serde(skip_serializing_if = "Option::is_none")]
        phase: Option<&'a str>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pct: Option<u8>,
    },
    Warn {
        code: &'a str,
        message: String,
    },
    Error {
        code: &'static str,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        hint: Option<&'a str>,
    },
    Debug {
        t_ms: u128,
        #[serde(skip_serializing_if = "Option::is_none")]
        event: Option<&'a str>,
        message: String,
        #[serde(skip_serializing_if = "serde_json::Value::is_null")]
        fields: serde_json::Value,
    },
}

impl<'a> Event<'a> {
    pub fn progress(phase: Option<&'a str>, message: impl Into<String>) -> Self {
        Event::Progress {
            phase,
            message: message.into(),
            pct: None,
        }
    }

    pub fn progress_pct(phase: Option<&'a str>, message: impl Into<String>, pct: u8) -> Self {
        Event::Progress {
            phase,
            message: message.into(),
            pct: Some(pct),
        }
    }

    pub fn warn(code: &'a str, message: impl Into<String>) -> Self {
        Event::Warn {
            code,
            message: message.into(),
        }
    }

    pub fn error(code: ErrorCode, message: impl Into<String>, hint: Option<&'a str>) -> Self {
        Event::Error {
            code: code.as_str(),
            message: message.into(),
            hint,
        }
    }

    pub fn render(&self) -> String {
        serde_json::to_string(self).expect("event serialize")
    }

    pub fn emit(&self) {
        let line = self.render();
        let stderr = std::io::stderr();
        let mut lock = stderr.lock();
        let _ = writeln!(lock, "{line}");
    }
}

pub fn progress(phase: Option<&str>, message: impl Into<String>) {
    Event::progress(phase, message).emit()
}

pub fn warn(code: &str, message: impl Into<String>) {
    Event::warn(code, message).emit()
}

pub fn error(code: ErrorCode, message: impl Into<String>, hint: Option<&str>) {
    Event::error(code, message, hint).emit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_progress_line_is_one_json_object() {
        let s = Event::progress(Some("diarize"), "loading the CoreML model").render();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["kind"], "progress");
        assert_eq!(v["phase"], "diarize");
        assert_eq!(v["message"], "loading the CoreML model");
        assert!(!s.contains('\n'));
    }

    #[test]
    fn progress_serialises_pct_only_when_it_has_one() {
        let with = Event::progress_pct(Some("download"), "GET model.onnx", 12).render();
        let v: serde_json::Value = serde_json::from_str(&with).unwrap();
        assert_eq!(v["kind"], "progress");
        assert_eq!(v["phase"], "download");
        assert_eq!(v["pct"], 12);
        let without = Event::progress(Some("download"), "GET model.onnx").render();
        let v: serde_json::Value = serde_json::from_str(&without).unwrap();
        assert!(v.get("pct").is_none(), "{without}");
    }

    #[test]
    fn an_error_carries_its_code_and_hint() {
        let e = Event::error(
            crate::errors::ErrorCode::ModelMissing,
            "voice 'x' not installed",
            Some("kesha install --tts"),
        );
        let v: serde_json::Value = serde_json::from_str(&e.render()).unwrap();
        assert_eq!(v["code"], "E_MODEL_MISSING");
        assert_eq!(v["hint"], "kesha install --tts");
        assert_eq!(v["kind"], "error");
    }

    #[test]
    fn a_warning_carries_its_code() {
        let w = Event::warn(
            W_VAD_NOT_INSTALLED,
            "hint: audio is 400s; `kesha install --vad` would improve accuracy",
        );
        let v: serde_json::Value = serde_json::from_str(&w.render()).unwrap();
        assert_eq!(v["code"], "W_VAD_NOT_INSTALLED");
        assert_eq!(
            v["message"],
            "hint: audio is 400s; `kesha install --vad` would improve accuracy"
        );
    }

    #[test]
    fn messages_with_newlines_stay_one_line() {
        let s = Event::warn(W_GENERIC, "a\nb").render();
        assert_eq!(s.lines().count(), 1);
    }
}
