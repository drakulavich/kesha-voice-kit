//! Text-to-speech dispatch across per-engine modules.

use std::path::Path;

pub mod g2p;
pub mod kokoro;
pub mod piper;
pub mod ssml;
pub mod tokenizer;
pub mod voices;
pub mod wav;

/// Soft limit on input text length. Rejects absurdly long inputs that would
/// spend minutes on synthesis with poor quality.
pub const MAX_TEXT_CHARS: usize = 5000;

#[derive(Debug, thiserror::Error)]
pub enum TtsError {
    #[error("text is empty")]
    EmptyText,
    #[error("text exceeds {max} chars ({actual})")]
    TextTooLong { max: usize, actual: usize },
    #[error("synthesis failed: {0}")]
    SynthesisFailed(String),
}

/// Which TTS engine to run. Voice ids determine this via `voices::resolve_voice`.
pub enum EngineChoice<'a> {
    /// Kokoro-82M: separate model + per-voice style embedding + rate.
    Kokoro {
        model_path: &'a Path,
        voice_path: &'a Path,
        speed: f32,
    },
    /// Piper VITS: model + per-voice .onnx.json config.
    Piper {
        model_path: &'a Path,
        config_path: &'a Path,
        /// Speed multiplier: 1.0 = voice default, 2.0 = twice as fast, 0.5 = half speed.
        /// Mapped to Piper's `length_scale = 1 / speed`.
        speed: f32,
    },
}

pub struct SayOptions<'a> {
    pub text: &'a str,
    /// espeak language code, e.g. `en-us`, `ru`.
    pub lang: &'a str,
    pub engine: EngineChoice<'a>,
}

/// Synthesize speech and return WAV bytes (mono float32; sample rate depends on engine).
///
/// Loads the ONNX session fresh on each call (~100-800ms). Fine for one-shot CLI
/// usage; callers that synthesize in a loop should hold a [`kokoro::Kokoro`] or
/// [`piper::Piper`] instance and drive it via its `infer` method.
pub fn say(opts: SayOptions) -> Result<Vec<u8>, TtsError> {
    if opts.text.is_empty() {
        return Err(TtsError::EmptyText);
    }
    let len = opts.text.chars().count();
    if len > MAX_TEXT_CHARS {
        return Err(TtsError::TextTooLong {
            max: MAX_TEXT_CHARS,
            actual: len,
        });
    }

    let ipa = g2p::text_to_ipa(opts.text, opts.lang)
        .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
    if ipa.trim().is_empty() {
        return Err(TtsError::SynthesisFailed(
            "no phonemes produced for input (empty after G2P)".into(),
        ));
    }

    match opts.engine {
        EngineChoice::Kokoro {
            model_path,
            voice_path,
            speed,
        } => say_with_kokoro(&ipa, model_path, voice_path, speed),
        EngineChoice::Piper {
            model_path,
            config_path,
            speed,
        } => say_with_piper(&ipa, model_path, config_path, speed),
    }
}

fn say_with_kokoro(
    ipa: &str,
    model_path: &Path,
    voice_path: &Path,
    speed: f32,
) -> Result<Vec<u8>, TtsError> {
    let tok = tokenizer::Tokenizer::load()
        .map_err(|e| TtsError::SynthesisFailed(format!("tokenizer load: {e}")))?;
    let ids = tok.encode(ipa);
    if ids.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "no recognizable phonemes in input".into(),
        ));
    }
    let active = ids.len();
    let padded = tokenizer::Tokenizer::pad_to_context(ids);

    let voice = voices::load_voice(voice_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("voice load: {e}")))?;
    let style = voices::select_style(&voice, active);

    let mut k = kokoro::Kokoro::load(model_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("kokoro load: {e}")))?;
    let audio = k
        .infer(&padded, style, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    wav::encode_wav(&audio, kokoro::SAMPLE_RATE)
        .map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))
}

fn say_with_piper(
    ipa: &str,
    model_path: &Path,
    config_path: &Path,
    speed: f32,
) -> Result<Vec<u8>, TtsError> {
    let mut p = piper::Piper::load(model_path, config_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("piper load: {e}")))?;
    let ids = p.encode(ipa);
    // `encode` always emits BOS + EOS; anything beyond the empty-input baseline means
    // at least one phoneme matched. Parallel guard to the one in `say_with_kokoro`.
    if ids.len() <= p.encode("").len() {
        return Err(TtsError::SynthesisFailed(
            "no recognizable phonemes in input".into(),
        ));
    }
    let audio = p
        .infer_with_speed(&ids, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    wav::encode_wav(&audio, p.sample_rate())
        .map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))
}
