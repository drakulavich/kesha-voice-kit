//! Text-to-speech via Kokoro ONNX.

use std::path::Path;

pub mod g2p;
pub mod kokoro;
pub mod tokenizer;
pub mod voices;
pub mod wav;

/// Soft limit on input text length. Rejects absurdly long inputs that would
/// spend minutes on synthesis with poor quality (Kokoro context is 512 tokens).
pub const MAX_TEXT_CHARS: usize = 5000;

#[derive(Debug, thiserror::Error)]
pub enum TtsError {
    #[error("voice '{voice_id}' not installed. run: kesha install --tts")]
    VoiceNotInstalled { voice_id: String },
    #[error("text is empty")]
    EmptyText,
    #[error("text exceeds {max} chars ({actual})")]
    TextTooLong { max: usize, actual: usize },
    #[error("synthesis failed: {0}")]
    SynthesisFailed(String),
}

pub struct SayOptions<'a> {
    pub text: &'a str,
    /// espeak language code, e.g. `en-us`.
    pub lang: &'a str,
    pub speed: f32,
    pub model_path: &'a Path,
    pub voice_path: &'a Path,
}

/// Synthesize speech and return WAV bytes (24kHz mono float32).
pub fn say(opts: SayOptions) -> Result<Vec<u8>, TtsError> {
    if opts.text.is_empty() {
        return Err(TtsError::EmptyText);
    }
    if opts.text.chars().count() > MAX_TEXT_CHARS {
        return Err(TtsError::TextTooLong {
            max: MAX_TEXT_CHARS,
            actual: opts.text.chars().count(),
        });
    }

    let ipa = g2p::text_to_ipa(opts.text, opts.lang)
        .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
    let tok = tokenizer::Tokenizer::load()
        .map_err(|e| TtsError::SynthesisFailed(format!("tokenizer load: {e}")))?;
    let ids = tok.encode(&ipa);
    if ids.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "no recognizable phonemes in input".into(),
        ));
    }
    let active_count = ids.len();
    let padded = tokenizer::Tokenizer::pad_to_context(ids);

    let voice = voices::load_voice(opts.voice_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("voice load: {e}")))?;
    let style = voices::select_style(&voice, active_count);

    let mut k = kokoro::Kokoro::load(opts.model_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("kokoro load: {e}")))?;
    let audio = k
        .infer(&padded, style, opts.speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    let wav = wav::encode_wav(&audio, kokoro::SAMPLE_RATE)
        .map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))?;
    Ok(wav)
}
