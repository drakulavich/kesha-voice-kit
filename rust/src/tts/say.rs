//! TTS dispatcher: route a [`SayOptions`] request to the right per-engine
//! pipeline (Kokoro / Vosk / AVSpeech), thread SSML segmentation through it,
//! and encode the result into the caller's chosen wire format.
//!
//! Public entry points:
//! - [`say`] — one-shot synth-and-encode (re-exported from `tts/mod.rs`)
//! - [`say_kokoro`] / [`say_vosk`] — the same per-engine dispatch with the
//!   caller's cached sessions injected (the `--stdin-loop` path, #213)

use std::borrow::Cow;
use std::path::Path;
use std::time::Instant;

use super::encode::OutputFormat;
use super::{
    en, encode, g2p, kokoro, ru, sessions, ssml, EngineChoice, SayOptions, TtsError, MAX_TEXT_CHARS,
};

#[cfg(all(feature = "system_tts", target_os = "macos"))]
use super::avspeech;

/// Per-`<break>` ceiling so a hostile SSML input can't allocate gigabytes of
/// silence. 30s × 24 kHz × 4 B ≈ 2.9 MB max per tag, easily affordable.
const MAX_BREAK_SECS: f64 = 30.0;

fn silence_samples(dur: std::time::Duration, sample_rate: u32) -> Vec<f32> {
    let secs = dur.as_secs_f64().min(MAX_BREAK_SECS);
    let n = (secs * sample_rate as f64).round() as usize;
    vec![0.0_f32; n]
}

/// Saturating composition of the CLI `--rate` flag with an SSML
/// `<prosody rate>` multiplier. Both factors are unit-less multipliers
/// against the engine's default rate; the result is clamped to the
/// engine-safe range so downstream `Vosk::infer` / `Kokoro::infer` never
/// see a 0× or 10× rate that would render unintelligible audio.
///
/// Range pinned to `0.5..=2.0` per the #236 spike findings: both Vosk
/// (`vosk-model-tts-ru-0.9-multi`) and Kokoro (`kokoro-82M`) honor rate
/// within ~7% of theoretical at these endpoints; past them quality
/// degrades. Single source of truth for the clamp range — change here
/// and the shared walker in `walk_segments` picks it up.
///
/// Emits a `warn_once` to stderr the first time a clamp diverges from
/// the raw product — without that line, an SSML `rate="300%"` capped to
/// `2.0` looks indistinguishable from a clean 2× rate (#267 F9).
fn compose_rate(cli_rate: f32, ssml_rate: f32) -> f32 {
    let raw = cli_rate * ssml_rate;
    let clamped = raw.clamp(0.5, 2.0);
    // Exact bound check, not `(raw - clamped).abs() > EPSILON`: at raw≈0.5
    // the f32 ULP (~6e-8) is below `EPSILON` (~1.2e-7), so a value one ULP
    // outside the bound would clamp silently (Greptile P2 on #287). NaN
    // is unordered against any bound → `contains` returns false → the
    // warning DOES fire ("rate NaN ... clamped to NaN"). That's
    // intentional: NaN here means an upstream bug parsed `cli_rate` or
    // `ssml_rate` as not-a-number, and surfacing it on stderr beats
    // silently propagating NaN sample-rate params downstream.
    if !(0.5..=2.0).contains(&raw) {
        crate::tts::warn::warn_once(
            "compose-rate-clamped",
            &format!(
                "rate {raw:.2} (cli={cli_rate:.2} × ssml={ssml_rate:.2}) \
                 clamped to {clamped:.2} (engine-safe range 0.5..=2.0)"
            ),
        );
    }
    clamped
}

/// Synthesize speech and return WAV bytes (mono float32; sample rate depends on engine).
///
/// Loads the ONNX session fresh on each call (~100-800ms); callers that synthesize
/// in a loop should hold an engine handle and drive it via `infer` directly.
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
    let engine_label = engine_label(&opts.engine);
    crate::dtrace!(
        "tts::say engine={engine_label} lang={} ssml={} chars={len}",
        opts.lang,
        opts.ssml
    );

    match opts.engine {
        #[cfg(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        EngineChoice::FluidKokoro { voice_id, speed } => {
            say_fluid_kokoro(opts.text, voice_id, speed, opts.format, opts.ssml)
        }
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        EngineChoice::AVSpeech { voice_id, speed } => {
            say_avspeech(opts.text, voice_id, speed, opts.format, opts.ssml)
        }
        EngineChoice::Vosk {
            model_dir,
            speaker_id,
            speed,
        } => say_vosk(
            &mut sessions::VoskCache::new(),
            opts.text,
            model_dir,
            speaker_id,
            speed,
            opts.format,
            opts.ssml,
            opts.expand_abbrev,
        ),
        EngineChoice::Kokoro {
            model_path,
            voice_path,
            speed,
        } => say_kokoro(
            &mut sessions::TtsSessions::default(),
            opts.text,
            opts.lang,
            model_path,
            voice_path,
            speed,
            opts.format,
            opts.ssml,
            opts.expand_abbrev,
        ),
    }
}

fn engine_label(engine: &EngineChoice) -> &'static str {
    match engine {
        EngineChoice::Kokoro { .. } => "kokoro",
        #[cfg(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        EngineChoice::FluidKokoro { .. } => "fluid-kokoro",
        EngineChoice::Vosk { .. } => "vosk",
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        EngineChoice::AVSpeech { .. } => "avspeech",
    }
}

/// FluidAudio Kokoro arm: SSML → segment walker; plain text → synthesize directly.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn say_fluid_kokoro(
    text: &str,
    voice_id: &str,
    speed: f32,
    format: OutputFormat,
    ssml: bool,
) -> Result<Vec<u8>, TtsError> {
    if ssml {
        return synth_segments_fluid_kokoro(text, voice_id, speed, format);
    }
    let wav_bytes =
        super::fluid_kokoro::synthesize(text, voice_id, speed).map_err(|e| TtsError::Coded {
            // Preserve a precise code from the engine chain (e.g.
            // ScriptUnsupported for native-script input).
            code: crate::errors::code_of(&e),
            message: format!("fluid-kokoro: {e}"),
        })?;
    transcode_to(&wav_bytes, format)
}

/// AVSpeech arm: does its own G2P + synthesis inside Swift; rejects SSML (#141).
#[cfg(all(feature = "system_tts", target_os = "macos"))]
fn say_avspeech(
    text: &str,
    voice_id: &str,
    speed: f32,
    format: OutputFormat,
    ssml: bool,
) -> Result<Vec<u8>, TtsError> {
    if ssml {
        return Err(TtsError::Coded {
            code: crate::errors::ErrorCode::SsmlUnsupported,
            message: "SSML is not yet supported with macos-* voices (#141 follow-up)".into(),
        });
    }
    let wav_bytes = avspeech::synthesize(text, voice_id, speed, None)
        .map_err(|e| TtsError::SynthesisFailed(format!("avspeech: {e}")))?;
    transcode_to(&wav_bytes, format)
}

/// Vosk arm: owns its own G2P + text normalisation; bypasses our espeak/misaki path.
#[allow(clippy::too_many_arguments)]
pub(crate) fn say_vosk(
    vosk: &mut sessions::VoskCache,
    text: &str,
    model_dir: &Path,
    speaker_id: u32,
    speed: f32,
    format: OutputFormat,
    ssml: bool,
    expand_abbrev: bool,
) -> Result<Vec<u8>, TtsError> {
    if ssml {
        return synth_segments_vosk(
            vosk,
            text,
            model_dir,
            speaker_id,
            speed,
            format,
            expand_abbrev,
        );
    }
    say_with_vosk(
        vosk,
        text,
        model_dir,
        speaker_id,
        speed,
        format,
        expand_abbrev,
    )
}

/// Kokoro arm: SSML, English segment pipeline, and non-English G2P paths.
/// Sessions are injected so `--stdin-loop` reuses them across requests while
/// the one-shot path passes a fresh [`sessions::TtsSessions`].
#[allow(clippy::too_many_arguments)]
pub(crate) fn say_kokoro(
    tts_sessions: &mut sessions::TtsSessions,
    text: &str,
    lang: &str,
    model_path: &Path,
    voice_path: &Path,
    speed: f32,
    format: OutputFormat,
    ssml: bool,
    expand_abbrev: bool,
) -> Result<Vec<u8>, TtsError> {
    let segments = if ssml {
        let segments = ssml::parse(text).map_err(|e| TtsError::Coded {
            code: crate::errors::code_of(&e),
            message: format!("ssml: {e:#}"),
        })?;
        if segments.is_empty() {
            return Err(TtsError::SynthesisFailed(
                "SSML had no speakable content".into(),
            ));
        }
        segments
    } else if en::is_en(lang) {
        // English: segment pipeline so IPA_LEXICON overrides bypass G2P;
        // letter-spell + STOP_LIST run inside en::normalize_segments (#244).
        vec![ssml::Segment::Text(text.to_string())]
    } else {
        let ipa = g2p::text_to_ipa_cached(&mut tts_sessions.charsiu, text, lang)
            .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
        if ipa.trim().is_empty() {
            return Err(TtsError::SynthesisFailed(
                "no phonemes produced for input (empty after G2P)".into(),
            ));
        }
        let sess = kokoro_session(&mut tts_sessions.kokoro, model_path)?;
        return say_with_kokoro(sess, &ipa, voice_path, speed, format);
    };
    // en::normalize_segments maps Spell→Text, expands acronyms, strips Emphasis.
    // Mirror of synth_segments_vosk's ru::normalize_segments call (#244).
    let segments = if en::is_en(lang) {
        en::normalize_segments(segments, expand_abbrev)
    } else {
        segments
    };
    let sess = kokoro_session(&mut tts_sessions.kokoro, model_path)?;
    let mut sink = KokoroSink {
        sess,
        charsiu: &mut tts_sessions.charsiu,
        lang,
        voice_path,
    };
    synth_segments(&mut sink, &segments, speed, format)
}

fn kokoro_session<'s>(
    slot: &'s mut sessions::KokoroSlot,
    model_path: &Path,
) -> Result<&'s mut sessions::KokoroSession, TtsError> {
    slot.get(model_path)
        .map_err(|e| TtsError::SynthesisFailed(format!("{e:#}")))
}

/// Per-engine leaf synthesis for the shared SSML walker. `Break` silence,
/// `ProsodyRate` recursion, the `Emphasis` strip-and-warn fallback, and the
/// empty-output check live once in [`synth_segments`]; a sink only knows how
/// to turn text / spelled text / IPA into samples.
trait SegmentSink {
    fn sample_rate(&mut self) -> Result<u32, TtsError>;
    fn text(&mut self, text: &str, speed: f32) -> Result<Vec<f32>, TtsError>;
    fn spell(&mut self, text: &str, speed: f32) -> Result<Vec<f32>, TtsError>;
    fn ipa(&mut self, ipa: &str, speed: f32) -> Result<Vec<f32>, TtsError>;
    fn emphasis_warning(&self) -> &'static str;
}

fn synth_segments(
    sink: &mut dyn SegmentSink,
    segments: &[ssml::Segment],
    speed: f32,
    format: OutputFormat,
) -> Result<Vec<u8>, TtsError> {
    let sample_rate = sink.sample_rate()?;
    let mut out: Vec<f32> = Vec::new();
    walk_segments(sink, segments, speed, sample_rate, &mut out)?;
    if out.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "no audio produced from SSML input".into(),
        ));
    }
    encode_or_fail(&out, sample_rate, format)
}

fn walk_segments(
    sink: &mut dyn SegmentSink,
    segments: &[ssml::Segment],
    speed: f32,
    sample_rate: u32,
    out: &mut Vec<f32>,
) -> Result<(), TtsError> {
    for seg in segments {
        match seg {
            ssml::Segment::Text(t) => out.extend(sink.text(t, speed)?),
            ssml::Segment::Spell(t) => out.extend(sink.spell(t, speed)?),
            ssml::Segment::Ipa(ph) => out.extend(sink.ipa(ph, speed)?),
            ssml::Segment::Break(dur) => out.extend(silence_samples(*dur, sample_rate)),
            // Defensive fallback: the en/ru normalizers convert Emphasis
            // upstream; skip the warning when suppress=true — level="none"
            // explicitly opted out of stress markers (#238, #244).
            ssml::Segment::Emphasis { content, suppress } => {
                if !suppress {
                    crate::tts::warn::warn_once("emphasis-non-ru-vosk", sink.emphasis_warning());
                }
                let stripped = super::strip_emphasis_markers(content.clone());
                out.extend(sink.text(&stripped, speed)?);
            }
            ssml::Segment::ProsodyRate { rate, content } => {
                let effective = compose_rate(speed, *rate);
                walk_segments(sink, content, effective, sample_rate, out)?;
            }
        }
    }
    Ok(())
}

struct KokoroSink<'a> {
    sess: &'a mut sessions::KokoroSession,
    charsiu: &'a mut sessions::CharsiuCache,
    lang: &'a str,
    voice_path: &'a Path,
}

impl KokoroSink<'_> {
    fn infer(&mut self, ipa: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        self.sess
            .infer_ipa(ipa, self.voice_path, speed)
            .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))
    }
}

impl SegmentSink for KokoroSink<'_> {
    fn sample_rate(&mut self) -> Result<u32, TtsError> {
        Ok(kokoro::SAMPLE_RATE)
    }
    fn text(&mut self, text: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        let ipa = g2p::text_to_ipa_cached(self.charsiu, text, self.lang)
            .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?;
        self.infer(&ipa, speed)
    }
    // Spell is G2P-routed like Text (the Vosk path normalizes Spell→Text upstream).
    fn spell(&mut self, text: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        self.text(text, speed)
    }
    fn ipa(&mut self, ipa: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        self.infer(ipa, speed)
    }
    fn emphasis_warning(&self) -> &'static str {
        "<emphasis> stress markers are honored only on ru-vosk-* voices; \
         stripping `+` from content for non-Vosk path"
    }
}

/// SSML path for FluidAudio Kokoro (CoreML/ANE), behind `system_kokoro`.
///
/// FluidAudio performs its own internal G2P from raw text, so — unlike the ONNX
/// Kokoro path — we deliberately do NOT run `en::normalize_segments` (which
/// would emit `Segment::Ipa` chunks FluidAudio cannot accept). Instead we walk
/// the parsed segments feeding plain text per chunk, threading `<prosody rate>`
/// into the model-native `speed` and interleaving `<break>` silence. This
/// restores the prosody/break parity the pre-#479 ONNX path had on
/// darwin-arm64 (closes #481).
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn synth_segments_fluid_kokoro(
    text: &str,
    voice_id: &str,
    speed: f32,
    format: OutputFormat,
) -> Result<Vec<u8>, TtsError> {
    let segments = ssml::parse(text).map_err(|e| TtsError::Coded {
        code: crate::errors::code_of(&e),
        message: format!("ssml: {e:#}"),
    })?;
    if segments.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "SSML had no speakable content".into(),
        ));
    }
    let synth = |t: &str, sp: f32| super::fluid_kokoro::synthesize_pcm(t, voice_id, sp);
    let mut sink = FluidKokoroSink { synth: &synth };
    synth_segments(&mut sink, &segments, speed, format)
}

/// `synth(text, speed)` turns a text chunk into f32 samples (the real impl
/// calls `fluid_kokoro::synthesize_pcm`; tests inject a deterministic fake).
/// FluidAudio does its own internal G2P, so `Spell` degrades to plain text
/// (warn-once) and `Ipa` is skipped (warn-once) — it can't accept IPA.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
struct FluidKokoroSink<'a> {
    synth: &'a dyn Fn(&str, f32) -> anyhow::Result<Vec<f32>>,
}

#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
impl FluidKokoroSink<'_> {
    fn synth(&self, text: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        (self.synth)(text, speed).map_err(|e| TtsError::Coded {
            // Preserve a precise code from the engine chain (e.g.
            // ScriptUnsupported for native-script input); plain synthesis
            // failures carry no CodedError, so code_of falls back to Internal.
            code: crate::errors::code_of(&e),
            message: format!("fluid-kokoro: {e}"),
        })
    }
}

#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
impl SegmentSink for FluidKokoroSink<'_> {
    fn sample_rate(&mut self) -> Result<u32, TtsError> {
        Ok(super::fluid_kokoro::SAMPLE_RATE)
    }
    fn text(&mut self, text: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        self.synth(text, speed)
    }
    fn spell(&mut self, text: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        crate::tts::warn::warn_once(
            "spell-fluid-kokoro",
            "SSML <say-as interpret-as=\"characters\"> letter-spelling is not honored on \
             FluidAudio Kokoro; reading the content as plain text",
        );
        self.synth(text, speed)
    }
    fn ipa(&mut self, _ipa: &str, _speed: f32) -> Result<Vec<f32>, TtsError> {
        crate::tts::warn::warn_once(
            "ipa-fluid-kokoro",
            "SSML <phoneme alphabet=\"ipa\"> is not supported on FluidAudio Kokoro \
             (internal G2P only); skipping the phoneme segment",
        );
        Ok(Vec::new())
    }
    fn emphasis_warning(&self) -> &'static str {
        "<emphasis> stress markers are honored only on ru-vosk-* voices; \
         stripping `+` from content for FluidAudio Kokoro"
    }
}

fn say_with_kokoro(
    sess: &mut sessions::KokoroSession,
    ipa: &str,
    voice_path: &Path,
    speed: f32,
    format: OutputFormat,
) -> Result<Vec<u8>, TtsError> {
    // #275 D1: boundary trace so a "no recognizable phonemes in input"
    // bail carries inputs (IPA length + voice file) and outputs (sample
    // count + wall time) instead of pointing at nothing.
    let ipa_len = ipa.chars().count();
    crate::dtrace!(
        "kokoro::infer.start ipa_len={ipa_len} voice={}",
        voice_path.display()
    );
    let t = Instant::now();
    let audio = sess
        .infer_ipa(ipa, voice_path, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))?;
    crate::dtrace!(
        "kokoro::infer.end samples={} dt={}ms",
        audio.len(),
        t.elapsed().as_millis()
    );
    if audio.is_empty() {
        crate::dtrace!(
            "kokoro::infer.empty ipa_first_20={:?}",
            ipa.chars().take(20).collect::<String>()
        );
        return Err(TtsError::SynthesisFailed(
            "no recognizable phonemes in input".into(),
        ));
    }
    encode_or_fail(&audio, kokoro::SAMPLE_RATE, format)
}

fn say_with_vosk(
    vosk: &mut sessions::VoskCache,
    text: &str,
    model_dir: &Path,
    speaker_id: u32,
    speed: f32,
    format: OutputFormat,
    expand_abbrev: bool,
) -> Result<Vec<u8>, TtsError> {
    let normalized: Cow<'_, str> = if expand_abbrev {
        Cow::Owned(ru::expand_text(text))
    } else {
        Cow::Borrowed(text)
    };
    let (audio, sample_rate) = vosk
        .infer(model_dir, normalized.as_ref(), speaker_id, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk: {e}")))?;
    encode_or_fail(&audio, sample_rate, format)
}

#[allow(clippy::too_many_arguments)]
fn synth_segments_vosk(
    vosk: &mut sessions::VoskCache,
    text: &str,
    model_dir: &Path,
    speaker_id: u32,
    speed: f32,
    format: OutputFormat,
    expand_abbrev: bool,
) -> Result<Vec<u8>, TtsError> {
    let segments = ssml::parse(text).map_err(|e| TtsError::Coded {
        code: crate::errors::code_of(&e),
        message: format!("ssml: {e:#}"),
    })?;
    if segments.is_empty() {
        return Err(TtsError::SynthesisFailed(
            "SSML had no speakable content".into(),
        ));
    }
    let segments = ru::normalize_segments(segments, expand_abbrev);
    let mut sink = VoskSink {
        cache: vosk,
        model_dir,
        speaker_id,
    };
    synth_segments(&mut sink, &segments, speed, format)
}

struct VoskSink<'a> {
    cache: &'a mut sessions::VoskCache,
    model_dir: &'a Path,
    speaker_id: u32,
}

impl VoskSink<'_> {
    fn infer(&mut self, text: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        let (audio, _sr) = self
            .cache
            .infer(self.model_dir, text, self.speaker_id, speed)
            .map_err(|e| TtsError::SynthesisFailed(format!("vosk: {e}")))?;
        Ok(audio)
    }
}

impl SegmentSink for VoskSink<'_> {
    fn sample_rate(&mut self) -> Result<u32, TtsError> {
        self.cache
            .sample_rate(self.model_dir)
            .map_err(|e| TtsError::SynthesisFailed(format!("vosk: {e}")))
    }
    fn text(&mut self, text: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        self.infer(text, speed)
    }
    // ru::normalize_segments converts Spell/Ipa→Text upstream; kept for completeness.
    fn spell(&mut self, text: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        self.infer(text, speed)
    }
    fn ipa(&mut self, ipa: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        self.infer(ipa, speed)
    }
    fn emphasis_warning(&self) -> &'static str {
        "<emphasis> reached the Vosk synth without ru::normalize_segments \
         preprocessing; stripping `+` markers as a fallback"
    }
}

/// Common tail: PCM samples → chosen wire format. Centralised so every engine
/// path emits the same error shape when encoding fails (#223).
fn encode_or_fail(
    samples: &[f32],
    sample_rate: u32,
    format: OutputFormat,
) -> Result<Vec<u8>, TtsError> {
    encode::encode(samples, sample_rate, format)
        .map_err(|e| TtsError::SynthesisFailed(format!("encode: {e}")))
}

/// Re-encode WAV bytes from a Swift sidecar into the caller's chosen format.
/// WAV → WAV short-circuits to avoid a hound round-trip.
#[cfg(any(
    all(feature = "system_tts", target_os = "macos"),
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    )
))]
fn transcode_to(wav_bytes: &[u8], format: OutputFormat) -> Result<Vec<u8>, TtsError> {
    if matches!(format, OutputFormat::Wav) {
        return Ok(wav_bytes.to_vec());
    }
    let reader = hound::WavReader::new(std::io::Cursor::new(wav_bytes))
        .map_err(|e| TtsError::SynthesisFailed(format!("sidecar wav decode: {e}")))?;
    let spec = reader.spec();
    let samples = wav_to_mono_f32(reader)
        .map_err(|e| TtsError::SynthesisFailed(format!("sidecar wav decode: {e}")))?;
    encode_or_fail(&samples, spec.sample_rate, format)
}

/// Mix WAV samples to mono f32. Generic so a future sidecar format change
/// doesn't break us (AVSpeech currently emits 22.05 kHz 16-bit mono).
#[cfg(any(
    all(feature = "system_tts", target_os = "macos"),
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    )
))]
fn wav_to_mono_f32<R: std::io::Read>(mut reader: hound::WavReader<R>) -> anyhow::Result<Vec<f32>> {
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<Vec<f32>, _>>()?,
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<Result<Vec<f32>, _>>()?
        }
    };
    if channels == 1 {
        return Ok(samples);
    }
    Ok(samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn prosody_rate_multiplies_and_clamps() {
        let cases = [
            (1.0_f32, 1.0_f32, 1.0_f32), // identity
            (0.8, 0.75, 0.6),            // 0.8 × 0.75 = 0.6, within range
            (0.5, 0.5, 0.5),             // 0.25 → clamped up to 0.5
            (2.0, 2.0, 2.0),             // 4.0 → clamped down to 2.0
            (1.0, 0.5, 0.5),             // identity × x-slow
            (1.0, 1.5, 1.5),             // identity × x-fast
        ];
        for (cli, ssml, expected) in cases {
            let effective = super::compose_rate(cli, ssml);
            assert!(
                (effective - expected).abs() < 1e-6,
                "cli={cli}, ssml={ssml}: got {effective}, expected {expected}"
            );
        }
    }

    #[test]
    fn compose_rate_warns_once_on_clamp() {
        // F9: clamping must surface a stderr warn so a user passing
        // SSML rate="300%" learns it was capped. Subsequent clamps reuse
        // the same key — process-wide warn_once dedupes.
        let _ = super::compose_rate(2.0, 2.0); // 4.0 → 2.0 (clamp high)
        assert!(
            crate::tts::warn::was_warned("compose-rate-clamped"),
            "compose_rate must record the warn key when clamping"
        );
        // Idempotent: a second clamp doesn't change set membership.
        let _ = super::compose_rate(0.1, 0.1); // 0.01 → 0.5 (clamp low)
        assert!(crate::tts::warn::was_warned("compose-rate-clamped"));
    }

    #[test]
    fn compose_rate_in_range_does_not_warn() {
        // The `0.5..=2.0` range is honored exactly — values just inside
        // the bounds must NOT trigger the clamp warning. (Outside-the-
        // bound coverage is exercised by `compose_rate_warns_once_on_clamp`
        // above; we can't assert "warn key absent" portably because the
        // warn set persists across tests in this `cargo test --lib` proc.)
        assert!((super::compose_rate(0.5, 1.0) - 0.5).abs() < 1e-6);
        assert!((super::compose_rate(2.0, 1.0) - 2.0).abs() < 1e-6);
        assert!((super::compose_rate(1.0, 1.0) - 1.0).abs() < 1e-6);
    }
}

/// Walker tests for the FluidAudio Kokoro SSML path (#481). A fake `synth`
/// callback records `(text, speed)` and returns one sentinel sample per
/// character, so the whole table runs without the FluidAudio model. Gated on
/// the same triple as the walker; runs locally on darwin-arm64 and is
/// compile-checked by CI's macos `system_kokoro` clippy step.
#[cfg(all(
    test,
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
mod fluid_kokoro_ssml_tests {
    use super::*;
    use crate::tts::ssml::Segment;
    use std::cell::RefCell;
    use std::time::Duration;

    /// Build a fake synth recording every call into `log`; returns
    /// `text.chars().count()` sentinel samples so the caller can assert which
    /// chunks were synthesized and in what order.
    fn recording_synth(
        log: &RefCell<Vec<(String, f32)>>,
    ) -> impl Fn(&str, f32) -> anyhow::Result<Vec<f32>> + '_ {
        move |t: &str, sp: f32| {
            log.borrow_mut().push((t.to_string(), sp));
            Ok(vec![0.5_f32; t.chars().count()])
        }
    }

    fn walk(
        synth: &dyn Fn(&str, f32) -> anyhow::Result<Vec<f32>>,
        segs: &[Segment],
        speed: f32,
        out: &mut Vec<f32>,
    ) {
        let mut sink = FluidKokoroSink { synth };
        walk_segments(&mut sink, segs, speed, 24_000, out).unwrap();
    }

    #[test]
    fn text_and_break_concatenate_with_silence() {
        let log = RefCell::new(Vec::new());
        let synth = recording_synth(&log);
        let mut out = Vec::new();
        // 24 kHz × 0.25 s = 6000 samples of silence between two text chunks.
        let segs = [
            Segment::Text("abc".into()),
            Segment::Break(Duration::from_millis(250)),
            Segment::Text("de".into()),
        ];
        walk(&synth, &segs, 1.0, &mut out);
        assert_eq!(out.len(), 3 + 6000 + 2);
        let calls = log.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "abc");
        assert_eq!(calls[1].0, "de");
    }

    #[test]
    fn prosody_rate_threads_composed_speed_to_inner_text() {
        let log = RefCell::new(Vec::new());
        let synth = recording_synth(&log);
        let mut out = Vec::new();
        // x-fast (1.5) wrapping the whole utterance, CLI rate 1.0 → effective 1.5.
        let seg = Segment::ProsodyRate {
            rate: 1.5,
            content: vec![Segment::Text("hi".into())],
        };
        walk(&synth, std::slice::from_ref(&seg), 1.0, &mut out);
        let calls = log.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "hi");
        assert!(
            (calls[0].1 - 1.5).abs() < 1e-6,
            "expected composed speed 1.5, got {}",
            calls[0].1
        );
    }

    #[test]
    fn emphasis_strips_plus_markers_before_synth() {
        let log = RefCell::new(Vec::new());
        let synth = recording_synth(&log);
        let mut out = Vec::new();
        let seg = Segment::Emphasis {
            content: "д+ома".into(),
            suppress: false,
        };
        walk(&synth, std::slice::from_ref(&seg), 1.0, &mut out);
        let calls = log.borrow();
        assert_eq!(calls[0].0, "дома", "`+` stress markers must be stripped");
    }

    #[test]
    fn spell_segment_reads_as_plain_text() {
        // FluidAudio can't letter-spell, so `<say-as interpret-as="characters">`
        // degrades to synthesizing the raw content (warn-once on the side).
        let log = RefCell::new(Vec::new());
        let synth = recording_synth(&log);
        let mut out = Vec::new();
        let seg = Segment::Spell("ВОЗ".into());
        walk(&synth, std::slice::from_ref(&seg), 1.0, &mut out);
        let calls = log.borrow();
        assert_eq!(calls.len(), 1, "Spell must synthesize its content as text");
        assert_eq!(calls[0].0, "ВОЗ");
        assert_eq!(out.len(), 3, "expected one sentinel sample per character");
    }

    #[test]
    fn ipa_segment_is_skipped_without_calling_synth() {
        let log = RefCell::new(Vec::new());
        let synth = recording_synth(&log);
        let mut out = Vec::new();
        // FluidAudio's internal G2P can't accept IPA; the segment is dropped.
        let seg = Segment::Ipa("həˈloʊ".into());
        walk(&synth, std::slice::from_ref(&seg), 1.0, &mut out);
        assert!(out.is_empty(), "Ipa segment must produce no audio");
        assert!(log.borrow().is_empty(), "synth must not be called for Ipa");
    }
}
