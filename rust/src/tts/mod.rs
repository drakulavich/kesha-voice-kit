//! Text-to-speech via Kokoro ONNX. See design doc 2026-04-16.
#![allow(dead_code)] // M1 skeleton

pub mod g2p;
pub mod kokoro;
pub mod tokenizer;
pub mod voices;
pub mod wav;

#[derive(Debug, thiserror::Error)]
pub enum TtsError {
    #[error("voice '{0}' not installed. run: kesha install --tts --voice {1}")]
    VoiceNotInstalled(String, String),
    #[error("text is empty")]
    EmptyText,
    #[error("text exceeds {max} chars ({actual})")]
    TextTooLong { max: usize, actual: usize },
    #[error("synthesis failed: {0}")]
    SynthesisFailed(String),
}
