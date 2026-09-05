//! One NDJSON event per stderr line under `KESHA_PROTOCOL=4`; today's prose otherwise.

use crate::errors::ErrorCode;
use serde::Serialize;
use std::io::Write;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    V3,
    V4,
}

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

pub fn mode_for(value: Option<&str>) -> Mode {
    match value.map(str::trim) {
        Some("4") => Mode::V4,
        _ => Mode::V3,
    }
}

/// Read once: the CLI sets `KESHA_PROTOCOL=4` before spawn and the mode cannot change mid-run.
pub fn mode() -> Mode {
    static CACHE: OnceLock<Mode> = OnceLock::new();
    *CACHE.get_or_init(|| mode_for(std::env::var("KESHA_PROTOCOL").ok().as_deref()))
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Event<'a> {
    Progress {
        #[serde(skip_serializing_if = "Option::is_none")]
        phase: Option<&'a str>,
        message: String,
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

    pub fn render(&self, mode: Mode) -> String {
        match mode {
            Mode::V4 => serde_json::to_string(self).expect("event serialize"),
            Mode::V3 => match self {
                Event::Progress {
                    phase: Some(p),
                    message,
                } => format!("{p}: {message}"),
                Event::Progress {
                    phase: None,
                    message,
                }
                | Event::Warn { message, .. } => message.clone(),
                Event::Error { code, message, .. } => format!("error [{code}]: {message}"),
                Event::Debug { t_ms, message, .. } => format!("[debug/engine +{t_ms}ms] {message}"),
            },
        }
    }

    pub fn emit(&self) {
        let line = self.render(mode());
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
    fn v4_progress_line_is_one_json_object() {
        let s = Event::progress(Some("diarize"), "loading the CoreML model").render(Mode::V4);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["kind"], "progress");
        assert_eq!(v["phase"], "diarize");
        assert_eq!(v["message"], "loading the CoreML model");
        assert!(!s.contains('\n'));
    }

    #[test]
    fn v3_progress_line_keeps_the_phase_prefix_and_bare_text() {
        assert_eq!(
            Event::progress(Some("diarize"), "done in 1.2s").render(Mode::V3),
            "diarize: done in 1.2s"
        );
        assert_eq!(
            Event::progress(None, "GET model.onnx").render(Mode::V3),
            "GET model.onnx"
        );
    }

    #[test]
    fn error_renders_legacy_line_in_v3_and_event_in_v4() {
        let e = Event::error(
            crate::errors::ErrorCode::ModelMissing,
            "voice 'x' not installed",
            Some("kesha install --tts"),
        );
        assert_eq!(
            e.render(Mode::V3),
            "error [E_MODEL_MISSING]: voice 'x' not installed"
        );
        let v: serde_json::Value = serde_json::from_str(&e.render(Mode::V4)).unwrap();
        assert_eq!(v["code"], "E_MODEL_MISSING");
        assert_eq!(v["hint"], "kesha install --tts");
        assert_eq!(v["kind"], "error");
    }

    #[test]
    fn warn_carries_a_code_in_v4_and_only_its_text_in_v3() {
        let w = Event::warn(
            W_VAD_NOT_INSTALLED,
            "hint: audio is 400s; `kesha install --vad` would improve accuracy",
        );
        assert_eq!(
            w.render(Mode::V3),
            "hint: audio is 400s; `kesha install --vad` would improve accuracy"
        );
        let v: serde_json::Value = serde_json::from_str(&w.render(Mode::V4)).unwrap();
        assert_eq!(v["code"], "W_VAD_NOT_INSTALLED");
    }

    #[test]
    fn mode_parses_only_the_literal_4() {
        assert_eq!(mode_for(Some("4")), Mode::V4);
        assert_eq!(mode_for(Some(" 4 ")), Mode::V4);
        assert_eq!(mode_for(Some("3")), Mode::V3);
        assert_eq!(mode_for(None), Mode::V3);
        assert_eq!(mode_for(Some("")), Mode::V3);
    }

    #[test]
    fn messages_with_newlines_stay_one_line_in_v4() {
        let s = Event::warn(W_GENERIC, "a\nb").render(Mode::V4);
        assert_eq!(s.lines().count(), 1);
    }
}
