//! Text-to-speech dispatch across per-engine modules.

use std::path::Path;

pub mod g2p;
pub mod kokoro;
pub mod piper;
pub mod ssml;
pub mod tokenizer;
pub mod voices;
pub mod wav;

#[cfg(all(feature = "system_tts", target_os = "macos"))]
pub mod avspeech;

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
    /// macOS AVSpeechSynthesizer via the Swift sidecar (#141).
    /// `voice_id` is forwarded verbatim (an Apple identifier or a language code).
    #[cfg(all(feature = "system_tts", target_os = "macos"))]
    AVSpeech { voice_id: &'a str },
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
    /// When true, `text` is parsed as SSML (issue #122). `<break>` tags yield
    /// silence of the declared duration; unknown tags are stripped with a warning.
    pub ssml: bool,
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
    let engine_label: &str = match &opts.engine {
        EngineChoice::Kokoro { .. } => "kokoro",
        EngineChoice::Piper { .. } => "piper",
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        EngineChoice::AVSpeech { .. } => "avspeech",
    };
    crate::dtrace!(
        "tts::say engine={engine_label} lang={} ssml={} chars={len}",
        opts.lang,
        opts.ssml
    );

    // AVSpeech does its own G2P + synthesis inside Swift; skip espeak G2P entirely.
    #[cfg(all(feature = "system_tts", target_os = "macos"))]
    if let EngineChoice::AVSpeech { voice_id } = &opts.engine {
        if opts.ssml {
            return Err(TtsError::SynthesisFailed(
                "SSML is not yet supported with macos-* voices (#141 follow-up)".into(),
            ));
        }
        return avspeech::synthesize(opts.text, voice_id, None)
            .map_err(|e| TtsError::SynthesisFailed(format!("avspeech: {e}")));
    }

    if opts.ssml {
        return say_ssml(&opts);
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
        // The AVSpeech arm is handled by the early-return above. Keep a guard
        // arm so the match stays exhaustive when the feature is enabled.
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        EngineChoice::AVSpeech { .. } => unreachable!("handled by early return above"),
    }
}

/// SSML path: parse, then synthesize each text segment through the engine (loaded once),
/// interleaving silence for `<break>` segments. Concatenate the f32 samples and wrap as WAV.
fn say_ssml(opts: &SayOptions) -> Result<Vec<u8>, TtsError> {
    let segments =
        ssml::parse(opts.text).map_err(|e| TtsError::SynthesisFailed(format!("ssml: {e}")))?;
    if segments.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "SSML had no speakable content".into(),
        ));
    }

    match &opts.engine {
        EngineChoice::Kokoro {
            model_path,
            voice_path,
            speed,
        } => synth_segments_kokoro(&segments, opts.lang, model_path, voice_path, *speed),
        EngineChoice::Piper {
            model_path,
            config_path,
            speed,
        } => synth_segments_piper(&segments, opts.lang, model_path, config_path, *speed),
        // AVSpeech + SSML is rejected up-front in `say()`; this arm keeps the match exhaustive.
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        EngineChoice::AVSpeech { .. } => {
            unreachable!("AVSpeech + SSML rejected in say() early return")
        }
    }
}

fn synth_segments_kokoro(
    segments: &[ssml::Segment],
    lang: &str,
    model_path: &Path,
    voice_path: &Path,
    speed: f32,
) -> Result<Vec<u8>, TtsError> {
    let tok = tokenizer::Tokenizer::load()
        .map_err(|e| TtsError::SynthesisFailed(format!("tokenizer load: {e}")))?;
    let voice = voices::load_voice(voice_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("voice load: {e}")))?;
    let mut k = kokoro::Kokoro::load(model_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("kokoro load: {e}")))?;
    let sample_rate = kokoro::SAMPLE_RATE;
    let mut out: Vec<f32> = Vec::new();
    for seg in segments {
        match seg {
            ssml::Segment::Text(t) => {
                let ipa = g2p::text_to_ipa(t, lang)
                    .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
                let ids = tok.encode(&ipa);
                if ids.is_empty() {
                    continue; // silent drop of non-speakable fragments
                }
                let active = ids.len();
                let padded = tokenizer::Tokenizer::pad_to_context(ids);
                let style = voices::select_style(&voice, active);
                let audio = k
                    .infer(&padded, style, speed)
                    .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
                out.extend(audio);
            }
            ssml::Segment::Break(dur) => {
                let samples = ((dur.as_secs_f64() * sample_rate as f64).round()) as usize;
                out.extend(std::iter::repeat_n(0.0_f32, samples));
            }
        }
    }
    if out.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "no audio produced from SSML input".into(),
        ));
    }
    wav::encode_wav(&out, sample_rate).map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))
}

fn synth_segments_piper(
    segments: &[ssml::Segment],
    lang: &str,
    model_path: &Path,
    config_path: &Path,
    speed: f32,
) -> Result<Vec<u8>, TtsError> {
    let mut p = piper::Piper::load(model_path, config_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("piper load: {e}")))?;
    let sample_rate = p.sample_rate();
    let empty_baseline = p.encode("").len();
    let mut out: Vec<f32> = Vec::new();
    for seg in segments {
        match seg {
            ssml::Segment::Text(t) => {
                let ipa = g2p::text_to_ipa(t, lang)
                    .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
                let ids = p.encode(&ipa);
                if ids.len() <= empty_baseline {
                    continue; // only BOS/EOS/pad — nothing to speak
                }
                let audio = p
                    .infer_with_speed(&ids, speed)
                    .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
                out.extend(audio);
            }
            ssml::Segment::Break(dur) => {
                let samples = ((dur.as_secs_f64() * sample_rate as f64).round()) as usize;
                out.extend(std::iter::repeat_n(0.0_f32, samples));
            }
        }
    }
    if out.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "no audio produced from SSML input".into(),
        ));
    }
    wav::encode_wav(&out, sample_rate).map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))
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
