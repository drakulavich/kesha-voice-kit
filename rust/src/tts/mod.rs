//! Text-to-speech dispatch across per-engine modules.

use std::path::Path;

pub mod g2p;
pub mod kokoro;
pub mod ssml;
pub mod tokenizer;
pub mod voices;
pub mod vosk;
pub mod wav;

#[cfg(all(feature = "system_tts", target_os = "macos"))]
pub mod avspeech;

/// Soft limit on input text length. Rejects absurdly long inputs that would
/// spend minutes on synthesis with poor quality.
pub const MAX_TEXT_CHARS: usize = 5000;

/// Per-`<break>` ceiling so a hostile SSML input can't allocate gigabytes of
/// silence. 30s × 24 kHz × 4 B ≈ 2.9 MB max per tag, easily affordable.
const MAX_BREAK_SECS: f64 = 30.0;

/// Build a zero-PCM silence buffer for an SSML `<break>`, capped at
/// [`MAX_BREAK_SECS`] regardless of declared duration.
fn silence_samples(dur: std::time::Duration, sample_rate: u32) -> Vec<f32> {
    let secs = dur.as_secs_f64().min(MAX_BREAK_SECS);
    let n = (secs * sample_rate as f64).round() as usize;
    vec![0.0_f32; n]
}

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
    /// Vosk-TTS Russian: model dir + speaker id (G2P happens inside vosk).
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
}

/// Synthesize speech and return WAV bytes (mono float32; sample rate depends on engine).
///
/// Loads the ONNX session fresh on each call (~100-800ms). Fine for one-shot CLI
/// usage; callers that synthesize in a loop should hold a [`kokoro::Kokoro`] or
/// [`vosk::Vosk`] instance and drive it via its `infer` method.
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
        EngineChoice::Vosk { .. } => "vosk",
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

    // Vosk-tts owns its own G2P + text normalisation; bypass our espeak/misaki path.
    if let EngineChoice::Vosk {
        model_dir,
        speaker_id,
        speed,
    } = &opts.engine
    {
        if opts.ssml {
            return synth_segments_vosk(opts.text, model_dir, *speaker_id, *speed);
        }
        return say_with_vosk(opts.text, model_dir, *speaker_id, *speed);
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
        // Vosk and AVSpeech are handled by early-returns above. Keep guard arms
        // so the match stays exhaustive when those features are enabled.
        EngineChoice::Vosk { .. } => unreachable!("handled by early return above"),
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
        // Vosk + SSML is handled by the early-return in say(); this arm keeps the match exhaustive.
        EngineChoice::Vosk { .. } => unreachable!("handled by early return in say()"),
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
                synth_ipa_kokoro(&ipa, &tok, &voice, &mut k, speed, &mut out)?;
            }
            ssml::Segment::Ipa(ph) => {
                synth_ipa_kokoro(ph, &tok, &voice, &mut k, speed, &mut out)?;
            }
            ssml::Segment::Break(dur) => out.extend(silence_samples(*dur, sample_rate)),
        }
    }
    if out.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "no audio produced from SSML input".into(),
        ));
    }
    wav::encode_wav(&out, sample_rate).map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))
}

fn synth_ipa_kokoro(
    ipa: &str,
    tok: &tokenizer::Tokenizer,
    voice: &[f32],
    k: &mut kokoro::Kokoro,
    speed: f32,
    out: &mut Vec<f32>,
) -> Result<(), TtsError> {
    let ids = tok.encode(ipa);
    if ids.is_empty() {
        return Ok(()); // silent drop of non-speakable fragments
    }
    let active = ids.len();
    let padded = tokenizer::Tokenizer::pad_to_context(ids);
    let style = voices::select_style(voice, active);
    let audio = k
        .infer(&padded, style, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    out.extend(audio);
    Ok(())
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

fn say_with_vosk(
    text: &str,
    model_dir: &Path,
    speaker_id: u32,
    speed: f32,
) -> Result<Vec<u8>, TtsError> {
    let mut v = vosk::Vosk::load(model_dir)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk load: {e}")))?;
    let sample_rate = v.sample_rate();
    let audio = v
        .infer(text, speaker_id, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk infer: {e}")))?;
    wav::encode_wav(&audio, sample_rate).map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))
}

fn synth_segments_vosk(
    text: &str,
    model_dir: &Path,
    speaker_id: u32,
    speed: f32,
) -> Result<Vec<u8>, TtsError> {
    let segments =
        ssml::parse(text).map_err(|e| TtsError::SynthesisFailed(format!("ssml: {e}")))?;
    if segments.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "SSML had no speakable content".into(),
        ));
    }
    let mut v = vosk::Vosk::load(model_dir)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk load: {e}")))?;
    let sample_rate = v.sample_rate();
    let mut out: Vec<f32> = Vec::new();
    for seg in segments {
        match seg {
            ssml::Segment::Text(t) | ssml::Segment::Ipa(t) => {
                // Vosk has no IPA passthrough; <phoneme> falls back to text.
                let audio = v
                    .infer(&t, speaker_id, speed)
                    .map_err(|e| TtsError::SynthesisFailed(format!("vosk infer: {e}")))?;
                out.extend(audio);
            }
            ssml::Segment::Break(dur) => out.extend(silence_samples(dur, sample_rate)),
        }
    }
    if out.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "no audio produced from SSML input".into(),
        ));
    }
    wav::encode_wav(&out, sample_rate).map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))
}
