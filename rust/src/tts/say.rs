//! TTS dispatcher: route a [`SayOptions`] request to the right per-engine
//! pipeline (Kokoro / Vosk / AVSpeech), thread SSML segmentation through it,
//! and encode the result into the caller's chosen wire format.
//!
//! Public entry points:
//! - [`say`] — one-shot synth-and-encode (re-exported from `tts/mod.rs`)
//! - [`say_kokoro`] / [`say_vosk`] — the same per-engine dispatch with the
//!   caller's cached sessions injected (the `--stdin-loop` path, #213)

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

pub(crate) const WARN_EXPAND_ABBREV_IGNORED: &str = "no-expand-abbrev-ignored";

/// `--no-expand-abbrev` is accepted on every voice but only Vosk and the
/// English Kokoro path can act on it; the rest spell initialisms inside their
/// own G2P with no opt-out, so the request is announced rather than dropped (#842).
fn warn_expand_abbrev_ignored(engine: &str) {
    crate::tts::warn::warn_once(
        WARN_EXPAND_ABBREV_IGNORED,
        &format!(
            "--no-expand-abbrev has no effect with {engine}: acronym expansion is suppressible \
             only for ru-vosk-* voices and English on ONNX Kokoro builds. Synthesizing with the \
             engine's own initialism handling instead."
        ),
    );
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
            if !opts.expand_abbrev {
                warn_expand_abbrev_ignored("FluidAudio Kokoro voices");
            }
            say_fluid_kokoro(opts.text, voice_id, speed, opts.format, opts.ssml)
        }
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        EngineChoice::AVSpeech { voice_id, speed } => {
            if !opts.expand_abbrev {
                warn_expand_abbrev_ignored("macos-* AVSpeech voices");
            }
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
    let (samples, sample_rate) =
        super::fluid_kokoro::synthesize(text, voice_id, speed).map_err(|e| TtsError::Coded {
            // Preserve a precise code from the engine chain (e.g.
            // ScriptUnsupported for native-script input).
            code: crate::errors::code_of(&e),
            message: format!("fluid-kokoro: {e}"),
        })?;
    encode_or_fail(&samples, sample_rate, format)
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
    // Non-English Kokoro goes straight to CharsiuG2P, which never sees the
    // segment normalizer that would honor the flag.
    if !expand_abbrev && !en::is_en(lang) {
        warn_expand_abbrev_ignored("non-English Kokoro voices");
    }
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

/// One speakable segment on its way to a sink.
enum Speakable<'a> {
    Text(&'a str),
    Spell(&'a str),
    Ipa(&'a str),
}

/// Per-engine leaf synthesis for the shared SSML walker. `Break` silence,
/// `ProsodyRate` recursion, the `Emphasis` strip-and-warn fallback, and the
/// empty-output check live once in [`synth_segments`].
///
/// A sink splits its work in two so the walker can merge an adjacent run of
/// speakable segments into a single utterance (#825): [`SegmentSink::unit`]
/// turns one segment into the engine's native input string (IPA for ONNX
/// Kokoro, plain text for Vosk and FluidAudio), and [`SegmentSink::synth`]
/// turns a merged run of those into samples.
trait SegmentSink {
    fn sample_rate(&mut self) -> Result<u32, TtsError>;
    /// `None` drops the segment — FluidAudio cannot accept IPA.
    fn unit(&mut self, seg: Speakable<'_>) -> Result<Option<String>, TtsError>;
    fn synth(&mut self, unit: &str, speed: f32) -> Result<Vec<f32>, TtsError>;
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

/// Punctuation that binds to the word before it, so no separator is inserted
/// ahead of it — the lexicon leaves a token's trailing punct in the *next*
/// text segment, which would otherwise merge as `ˈiːpæm .`.
const CLINGING_PUNCTUATION: [char; 7] = [',', '.', ';', ':', '!', '?', '…'];

/// Append one speakable segment's engine-native form to the pending run,
/// separated by a single space unless either side already carries one.
fn push_unit(
    sink: &mut dyn SegmentSink,
    run: &mut String,
    seg: Speakable<'_>,
) -> Result<(), TtsError> {
    let Some(unit) = sink.unit(seg)? else {
        return Ok(());
    };
    if unit.is_empty() {
        return Ok(());
    }
    let clings = unit.starts_with(|c| CLINGING_PUNCTUATION.contains(&c));
    if !run.is_empty()
        && !clings
        && !run.ends_with(char::is_whitespace)
        && !unit.starts_with(char::is_whitespace)
    {
        run.push(' ');
    }
    run.push_str(&unit);
    Ok(())
}

/// Whitespace is collapsed so the engine sees the same input wherever the
/// segment boundaries happened to fall — a dropped unit between two spaced
/// segments would otherwise leave a double space behind (FluidAudio drops
/// `Ipa`), and on Kokoro each space is its own token.
fn flush_run(
    sink: &mut dyn SegmentSink,
    run: &mut String,
    speed: f32,
    out: &mut Vec<f32>,
) -> Result<(), TtsError> {
    let merged = run.split_whitespace().collect::<Vec<_>>().join(" ");
    run.clear();
    if merged.is_empty() {
        return Ok(());
    }
    out.extend(sink.synth(&merged, speed)?);
    Ok(())
}

/// Walk the segment list, synthesizing each maximal run of adjacent speakable
/// segments as one utterance. Only `Break` (deliberate silence) and
/// `ProsodyRate` (a different speed argument) end a run — every engine emits
/// per-utterance lead-in and tail padding, so a run split anywhere else would
/// stack that padding into a mid-sentence pause and restart the intonation
/// contour (#825).
fn walk_segments(
    sink: &mut dyn SegmentSink,
    segments: &[ssml::Segment],
    speed: f32,
    sample_rate: u32,
    out: &mut Vec<f32>,
) -> Result<(), TtsError> {
    let mut run = String::new();
    for seg in segments {
        match seg {
            ssml::Segment::Text(t) => push_unit(sink, &mut run, Speakable::Text(t))?,
            ssml::Segment::Spell(t) => push_unit(sink, &mut run, Speakable::Spell(t))?,
            ssml::Segment::Ipa(ph) => push_unit(sink, &mut run, Speakable::Ipa(ph))?,
            ssml::Segment::Break(dur) => {
                flush_run(sink, &mut run, speed, out)?;
                out.extend(silence_samples(*dur, sample_rate));
            }
            // Defensive fallback: the en/ru normalizers convert Emphasis
            // upstream; skip the warning when suppress=true — level="none"
            // explicitly opted out of stress markers (#238, #244).
            ssml::Segment::Emphasis { content, suppress } => {
                if !suppress {
                    crate::tts::warn::warn_once("emphasis-non-ru-vosk", sink.emphasis_warning());
                }
                let stripped = super::strip_emphasis_markers(content.clone());
                push_unit(sink, &mut run, Speakable::Text(&stripped))?;
            }
            ssml::Segment::ProsodyRate { rate, content } => {
                flush_run(sink, &mut run, speed, out)?;
                let effective = compose_rate(speed, *rate);
                walk_segments(sink, content, effective, sample_rate, out)?;
            }
        }
    }
    flush_run(sink, &mut run, speed, out)
}

struct KokoroSink<'a> {
    sess: &'a mut sessions::KokoroSession,
    charsiu: &'a mut sessions::CharsiuCache,
    lang: &'a str,
    voice_path: &'a Path,
}

impl SegmentSink for KokoroSink<'_> {
    fn sample_rate(&mut self) -> Result<u32, TtsError> {
        Ok(kokoro::SAMPLE_RATE)
    }
    // Spell is G2P-routed like Text (the en normalizer expands it upstream).
    fn unit(&mut self, seg: Speakable<'_>) -> Result<Option<String>, TtsError> {
        let ipa = match seg {
            Speakable::Ipa(ipa) => ipa.to_string(),
            Speakable::Text(t) | Speakable::Spell(t) => {
                g2p::text_to_ipa_cached(self.charsiu, t, self.lang)
                    .map_err(|e| TtsError::SynthesisFailed(format!("g2p: {e}")))?
            }
        };
        Ok(Some(ipa))
    }
    /// A merged run past Kokoro's active-token cap is split by `chunk_ipa`
    /// inside `infer_ipa`, so merging trades N utterance seams for at most
    /// one chunk seam per 510 phonemes (#715, #807).
    fn synth(&mut self, unit: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        self.sess
            .infer_ipa(unit, self.voice_path, speed)
            .map_err(|e| TtsError::SynthesisFailed(format!("infer: {e}")))
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
    fn unit(&mut self, seg: Speakable<'_>) -> Result<Option<String>, TtsError> {
        Ok(match seg {
            Speakable::Text(t) => Some(t.to_string()),
            Speakable::Spell(t) => {
                crate::tts::warn::warn_once(
                    "spell-fluid-kokoro",
                    "SSML <say-as interpret-as=\"characters\"> letter-spelling is not honored on \
                     FluidAudio Kokoro; reading the content as plain text",
                );
                Some(t.to_string())
            }
            Speakable::Ipa(_) => {
                crate::tts::warn::warn_once(
                    "ipa-fluid-kokoro",
                    "SSML <phoneme alphabet=\"ipa\"> is not supported on FluidAudio Kokoro \
                     (internal G2P only); skipping the phoneme segment",
                );
                None
            }
        })
    }
    fn synth(&mut self, unit: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        FluidKokoroSink::synth(self, unit, speed)
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
    let normalized = ru::expand_text(text, expand_abbrev);
    let (audio, sample_rate) = vosk
        .infer(model_dir, &normalized, speaker_id, speed)
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
    // Vosk owns its G2P, so every variant is plain text to it;
    // ru::normalize_segments expands Spell upstream.
    fn unit(&mut self, seg: Speakable<'_>) -> Result<Option<String>, TtsError> {
        let (Speakable::Text(t) | Speakable::Spell(t) | Speakable::Ipa(t)) = seg;
        Ok(Some(t.to_string()))
    }
    fn synth(&mut self, unit: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
        self.infer(unit, speed)
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
/// WAV → WAV goes through the round-trip too: #826 — passing sidecar PCM16
/// through untouched made `OutputFormat::Wav` mean two different encodings
/// depending on which engine served the request, and left those voices outside
/// the #245 plain-IEEE-float guarantee that `tts::wav` exists to hold.
// `test` joins the gate so the #826 regression test runs in the default
// `--features tts` lane, not only under the darwin sidecar features.
#[cfg(any(test, all(feature = "system_tts", target_os = "macos")))]
fn transcode_to(wav_bytes: &[u8], format: OutputFormat) -> Result<Vec<u8>, TtsError> {
    let reader = hound::WavReader::new(std::io::Cursor::new(wav_bytes))
        .map_err(|e| TtsError::SynthesisFailed(format!("sidecar wav decode: {e}")))?;
    let spec = reader.spec();
    let samples = wav_to_mono_f32(reader)
        .map_err(|e| TtsError::SynthesisFailed(format!("sidecar wav decode: {e}")))?;
    encode_or_fail(&samples, spec.sample_rate, format)
}

/// Mix WAV samples to mono f32. Generic because AVSpeech renders float32 at
/// whatever rate the chosen system voice runs at, and the tests feed it 16-bit
/// PCM.
#[cfg(any(test, all(feature = "system_tts", target_os = "macos")))]
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
    use super::*;

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

    /// #842: `--no-expand-abbrev` reaches the engine on every voice, but only
    /// Vosk and the English Kokoro path can act on it. Ignoring it in silence
    /// is what made `--help` unfalsifiable, so the ignored case must warn.
    #[test]
    fn no_expand_abbrev_warns_when_kokoro_cannot_honor_it() {
        let _ = say_kokoro(
            &mut sessions::TtsSessions::default(),
            "hola",
            "es",
            Path::new("/nonexistent/kokoro/model.onnx"),
            Path::new("/nonexistent/kokoro/voice.bin"),
            1.0,
            OutputFormat::Wav,
            false,
            false,
        );
        assert!(
            crate::tts::warn::was_warned(WARN_EXPAND_ABBREV_IGNORED),
            "a non-English Kokoro voice cannot suppress expansion and must say so"
        );
    }

    #[test]
    fn no_expand_abbrev_stays_quiet_on_the_english_kokoro_path() {
        let _ = say_kokoro(
            &mut sessions::TtsSessions::default(),
            "FBI",
            "en",
            Path::new("/nonexistent/kokoro/model.onnx"),
            Path::new("/nonexistent/kokoro/voice.bin"),
            1.0,
            OutputFormat::Wav,
            false,
            false,
        );
        assert!(
            !crate::tts::warn::was_warned(WARN_EXPAND_ABBREV_IGNORED),
            "English on Kokoro honors the flag; warning there would be the opposite lie"
        );
    }

    /// Records every synthesized utterance and returns one sentinel sample
    /// per char. Each variant tags its content so a mis-routed segment is
    /// visible in the merged run.
    struct RecordingSink {
        calls: Vec<(String, f32)>,
        fail_on_text: bool,
        fail_on_synth: bool,
    }

    impl RecordingSink {
        fn new() -> Self {
            Self {
                calls: Vec::new(),
                fail_on_text: false,
                fail_on_synth: false,
            }
        }
    }

    impl SegmentSink for RecordingSink {
        fn sample_rate(&mut self) -> Result<u32, TtsError> {
            // Deliberately not 1 kHz: durations in ms must NOT equal sample
            // counts, or a walker that ignores the rate would pass.
            Ok(8_000)
        }
        fn unit(&mut self, seg: Speakable<'_>) -> Result<Option<String>, TtsError> {
            Ok(Some(match seg {
                Speakable::Text(t) => {
                    if self.fail_on_text {
                        return Err(TtsError::SynthesisFailed("boom".into()));
                    }
                    t.to_string()
                }
                Speakable::Spell(t) => format!("spell:{t}"),
                Speakable::Ipa(p) => format!("ipa:{p}"),
            }))
        }
        fn synth(&mut self, unit: &str, speed: f32) -> Result<Vec<f32>, TtsError> {
            if self.fail_on_synth {
                return Err(TtsError::SynthesisFailed("kaboom".into()));
            }
            self.calls.push((unit.to_string(), speed));
            Ok(vec![0.5_f32; unit.chars().count()])
        }
        fn emphasis_warning(&self) -> &'static str {
            "recording-sink emphasis fallback"
        }
    }

    #[test]
    fn walker_routes_each_variant_to_its_leaf_and_sizes_breaks() {
        use std::time::Duration;
        let mut sink = RecordingSink::new();
        let mut out = Vec::new();
        let segs = [
            ssml::Segment::Text("ab".into()),
            ssml::Segment::Break(Duration::from_millis(250)), // 8 kHz → 2000 samples
            ssml::Segment::Spell("cde".into()),
            ssml::Segment::Ipa("fg".into()),
        ];
        walk_segments(&mut sink, &segs, 1.0, 8_000, &mut out).unwrap();
        assert_eq!(
            sink.calls,
            vec![
                ("ab".to_string(), 1.0),
                ("spell:cde ipa:fg".to_string(), 1.0),
            ]
        );
        assert_eq!(out.len(), 2 + 2_000 + "spell:cde ipa:fg".len());
    }

    #[test]
    fn walker_composes_nested_prosody_rates_with_clamp() {
        // In-range factors whose product differs from either factor alone:
        // only true multiplicative composition yields 0.8 × 0.9 = 0.72.
        let seg = ssml::Segment::ProsodyRate {
            rate: 0.8,
            content: vec![
                ssml::Segment::Text("outer".into()),
                ssml::Segment::ProsodyRate {
                    rate: 0.9,
                    content: vec![ssml::Segment::Text("inner".into())],
                },
            ],
        };
        let mut sink = RecordingSink::new();
        let mut out = Vec::new();
        walk_segments(&mut sink, std::slice::from_ref(&seg), 1.0, 8_000, &mut out).unwrap();
        // Two utterances, not one: <prosody rate> ends a merged run because
        // its content needs a different speed argument.
        assert_eq!(sink.calls.len(), 2, "{:?}", sink.calls);
        assert!((sink.calls[0].1 - 0.8).abs() < 1e-6, "{:?}", sink.calls);
        assert!((sink.calls[1].1 - 0.72).abs() < 1e-6, "{:?}", sink.calls);

        // And the ceiling: 1.5 × 2.0 = 3.0 clamps to the engine-safe 2.0.
        let clamped = ssml::Segment::ProsodyRate {
            rate: 1.5,
            content: vec![ssml::Segment::ProsodyRate {
                rate: 2.0,
                content: vec![ssml::Segment::Text("x".into())],
            }],
        };
        let mut sink = RecordingSink::new();
        let mut out = Vec::new();
        walk_segments(
            &mut sink,
            std::slice::from_ref(&clamped),
            1.0,
            8_000,
            &mut out,
        )
        .unwrap();
        assert!((sink.calls[0].1 - 2.0).abs() < 1e-6, "{:?}", sink.calls);
    }

    #[test]
    fn synth_segments_sizes_breaks_from_the_sink_rate() {
        use std::time::Duration;
        // Break-only SSML: the walker gets its sample rate from
        // sink.sample_rate() (8 kHz) — 250 ms must yield 2000 f32 samples in
        // the encoded WAV, not a millisecond-scaled or constant-rate count.
        let mut sink = RecordingSink::new();
        let bytes = synth_segments(
            &mut sink,
            &[ssml::Segment::Break(Duration::from_millis(250))],
            1.0,
            OutputFormat::Wav,
        )
        .unwrap();
        let pcm_bytes = 2_000 * 4;
        assert!(
            bytes.len() > pcm_bytes && bytes.len() <= pcm_bytes + 128,
            "expected ~{pcm_bytes} PCM bytes plus a small header, got {}",
            bytes.len()
        );
    }

    #[test]
    fn trailing_punctuation_joins_without_a_separator() {
        // The lexicon leaves a token's trailing punct in the following text
        // segment, so `<say-as>` / `<phoneme>` before a period must not merge
        // as "… ." — raw-text engines would read the gap as a pause.
        let mut sink = RecordingSink::new();
        let mut out = Vec::new();
        let segs = [
            ssml::Segment::Ipa("ˈiːpæm".into()),
            ssml::Segment::Text(", and more.".into()),
        ];
        walk_segments(&mut sink, &segs, 1.0, 8_000, &mut out).unwrap();
        assert_eq!(sink.calls, vec![("ipa:ˈiːpæm, and more.".to_string(), 1.0)]);
    }

    #[test]
    fn a_dropped_unit_between_spaced_segments_leaves_no_double_space() {
        // FluidAudio drops Ipa mid-run; the surrounding text keeps its own
        // spacing, which would otherwise splice into "before  after".
        struct DropIpaSink(Vec<String>);
        impl SegmentSink for DropIpaSink {
            fn sample_rate(&mut self) -> Result<u32, TtsError> {
                Ok(8_000)
            }
            fn unit(&mut self, seg: Speakable<'_>) -> Result<Option<String>, TtsError> {
                Ok(match seg {
                    Speakable::Ipa(_) => None,
                    Speakable::Text(t) | Speakable::Spell(t) => Some(t.to_string()),
                })
            }
            fn synth(&mut self, unit: &str, _speed: f32) -> Result<Vec<f32>, TtsError> {
                self.0.push(unit.to_string());
                Ok(vec![0.5_f32; unit.chars().count()])
            }
            fn emphasis_warning(&self) -> &'static str {
                "drop-ipa-sink emphasis fallback"
            }
        }

        let mut sink = DropIpaSink(Vec::new());
        let mut out = Vec::new();
        let segs = [
            ssml::Segment::Text("before ".into()),
            ssml::Segment::Ipa("hˈaɪ".into()),
            ssml::Segment::Text(" after".into()),
        ];
        walk_segments(&mut sink, &segs, 1.0, 8_000, &mut out).unwrap();
        assert_eq!(sink.0, vec!["before after".to_string()]);
    }

    /// Every inference emits its own lead-in and tail padding (#825). One
    /// call → `[silence, tone, silence]`; the walker must not stack those
    /// paddings mid-utterance.
    struct PaddedSink {
        pad: usize,
        tone: usize,
    }

    impl PaddedSink {
        fn new() -> Self {
            // 8 kHz: 300 ms of padding either side of 200 ms of tone.
            Self {
                pad: 2_400,
                tone: 1_600,
            }
        }
        fn utterance(&self) -> Vec<f32> {
            let mut v = vec![0.0_f32; self.pad];
            v.extend(std::iter::repeat_n(0.5_f32, self.tone));
            v.extend(std::iter::repeat_n(0.0_f32, self.pad));
            v
        }
    }

    impl SegmentSink for PaddedSink {
        fn sample_rate(&mut self) -> Result<u32, TtsError> {
            Ok(8_000)
        }
        fn unit(&mut self, seg: Speakable<'_>) -> Result<Option<String>, TtsError> {
            let (Speakable::Text(t) | Speakable::Spell(t) | Speakable::Ipa(t)) = seg;
            Ok(Some(t.to_string()))
        }
        fn synth(&mut self, _unit: &str, _speed: f32) -> Result<Vec<f32>, TtsError> {
            Ok(self.utterance())
        }
        fn emphasis_warning(&self) -> &'static str {
            "padded-sink emphasis fallback"
        }
    }

    /// Longest run of near-silence that is neither the leading nor the
    /// trailing one, in samples.
    fn longest_interior_silence(samples: &[f32]) -> usize {
        let loud = |s: &f32| s.abs() >= 1e-3;
        let Some(first) = samples.iter().position(loud) else {
            return 0;
        };
        let last = samples.iter().rposition(loud).unwrap();
        let mut longest = 0;
        let mut run = 0;
        for s in &samples[first..=last] {
            if loud(s) {
                run = 0;
            } else {
                run += 1;
                longest = longest.max(run);
            }
        }
        longest
    }

    #[test]
    fn adjacent_speech_segments_leave_no_interior_dead_air() {
        // "The JSON file is ready." — Text / Ipa / Text after the lexicon
        // rewrite. The user asked for no pause, so there must be none.
        let segs = [
            ssml::Segment::Text("The ".into()),
            ssml::Segment::Ipa("ˈdʒeɪsən".into()),
            ssml::Segment::Text(" file is ready.".into()),
        ];
        let mut sink = PaddedSink::new();
        let mut out = Vec::new();
        walk_segments(&mut sink, &segs, 1.0, 8_000, &mut out).unwrap();
        let dead = longest_interior_silence(&out);
        assert!(
            dead <= 800,
            "interior dead air of {} ms where none was requested",
            dead / 8
        );
    }

    #[test]
    fn explicit_break_still_produces_its_silence() {
        use std::time::Duration;
        let segs = [
            ssml::Segment::Text("before".into()),
            ssml::Segment::Break(Duration::from_millis(500)),
            ssml::Segment::Text("after".into()),
        ];
        let mut sink = PaddedSink::new();
        let mut out = Vec::new();
        walk_segments(&mut sink, &segs, 1.0, 8_000, &mut out).unwrap();
        assert!(
            longest_interior_silence(&out) >= 4_000,
            "the 500 ms <break> was swallowed"
        );
    }

    #[test]
    fn walker_strips_emphasis_markers_and_routes_to_text() {
        let seg = ssml::Segment::Emphasis {
            content: "д+ома".into(),
            suppress: true,
        };
        let mut sink = RecordingSink::new();
        let mut out = Vec::new();
        walk_segments(&mut sink, std::slice::from_ref(&seg), 1.0, 1_000, &mut out).unwrap();
        assert_eq!(sink.calls, vec![("дома".to_string(), 1.0)]);
    }

    #[test]
    fn synth_segments_rejects_empty_output_and_propagates_leaf_errors() {
        let mut sink = RecordingSink::new();
        let err = synth_segments(&mut sink, &[], 1.0, OutputFormat::Wav).unwrap_err();
        assert!(
            err.to_string()
                .contains("no audio produced from SSML input"),
            "{err}"
        );

        for (fail_g2p, expected) in [(true, "boom"), (false, "kaboom")] {
            let mut failing = RecordingSink::new();
            failing.fail_on_text = fail_g2p;
            failing.fail_on_synth = !fail_g2p;
            let err = synth_segments(
                &mut failing,
                &[ssml::Segment::Text("x".into())],
                1.0,
                OutputFormat::Wav,
            )
            .unwrap_err();
            assert!(err.to_string().contains(expected), "{err}");
        }
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

    /// Build a sidecar-shaped WAV: 16-bit PCM, the encoding FluidAudio Kokoro
    /// hands us. `channels` interleaves, matching how a multi-channel sidecar
    /// buffer would arrive.
    fn pcm16_wav(samples: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut writer = hound::WavWriter::new(&mut buf, spec).unwrap();
        for s in samples {
            writer.write_sample(*s).unwrap();
        }
        writer.finalize().unwrap();
        buf.into_inner()
    }

    /// Byte-for-byte what `swift/say-avspeech.swift` writes: IEEE float 32-bit
    /// with a 16-byte `fmt ` chunk and no `fact` chunk. hound reads it, but it
    /// is not the shape `wav::encode_wav` produces.
    fn avspeech_shaped_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
        let data_size = (samples.len() * 4) as u32;
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data_size).to_le_bytes());
        w.extend_from_slice(b"WAVE");
        w.extend_from_slice(b"fmt ");
        w.extend_from_slice(&16_u32.to_le_bytes());
        w.extend_from_slice(&3_u16.to_le_bytes());
        w.extend_from_slice(&1_u16.to_le_bytes());
        w.extend_from_slice(&sample_rate.to_le_bytes());
        w.extend_from_slice(&(sample_rate * 4).to_le_bytes());
        w.extend_from_slice(&4_u16.to_le_bytes());
        w.extend_from_slice(&32_u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&data_size.to_le_bytes());
        for s in samples {
            w.extend_from_slice(&s.to_le_bytes());
        }
        w
    }

    /// `(fmt chunk size, format tag, sample rate, bits per sample)`.
    fn fmt_chunk(wav: &[u8]) -> (u32, u16, u32, u16) {
        let at = (0..wav.len() - 8)
            .find(|i| &wav[*i..*i + 4] == b"fmt ")
            .expect("fmt chunk not found");
        let size = u32::from_le_bytes([wav[at + 4], wav[at + 5], wav[at + 6], wav[at + 7]]);
        let tag = u16::from_le_bytes([wav[at + 8], wav[at + 9]]);
        let rate = u32::from_le_bytes([wav[at + 12], wav[at + 13], wav[at + 14], wav[at + 15]]);
        let bits = u16::from_le_bytes([wav[at + 22], wav[at + 23]]);
        (size, tag, rate, bits)
    }

    fn has_fact_chunk(wav: &[u8]) -> bool {
        (0..wav.len() - 4).any(|i| &wav[i..i + 4] == b"fact")
    }

    fn decode_f32(wav: &[u8]) -> Vec<f32> {
        hound::WavReader::new(std::io::Cursor::new(wav))
            .unwrap()
            .into_samples::<f32>()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn wav_output_is_ieee_float_even_for_sidecar_pcm16() {
        // #826: `OutputFormat::Wav` used to pass sidecar bytes through untouched,
        // so the same voice emitted PCM16 for plain text and IEEE float for --ssml.
        let src = pcm16_wav(&[0, 8192, -8192, 16384, -16384, 32767, -32768], 22_050, 1);
        assert_eq!(fmt_chunk(&src), (16, 0x0001, 22_050, 16), "fixture shape");

        let out = super::transcode_to(&src, OutputFormat::Wav).unwrap();

        let (_, tag, rate, bits) = fmt_chunk(&out);
        assert_eq!(
            tag, 0x0003,
            "expected WAVE_FORMAT_IEEE_FLOAT (0x0003), got 0x{tag:04x}"
        );
        assert_eq!(bits, 32);
        assert_eq!(
            rate, 22_050,
            "sample rate stays per-voice; WAV pins the encoding, not the rate"
        );
    }

    #[test]
    fn avspeech_shaped_float_wav_is_rewritten_to_the_canonical_layout() {
        // AVSpeech already emits IEEE float, so #826 looked like a no-op here —
        // but its `fmt ` chunk is 16 bytes with no `cbSize` and no `fact`, which
        // is non-conformant for non-PCM. Now it goes through `wav::encode_wav`.
        let pcm: Vec<f32> = (0..512).map(|i| (i as f32 * 0.02).sin()).collect();
        let src = avspeech_shaped_wav(&pcm, 16_000);
        assert_eq!(fmt_chunk(&src), (16, 0x0003, 16_000, 32), "fixture shape");
        assert!(!has_fact_chunk(&src), "fixture must have no fact chunk");

        let out = super::transcode_to(&src, OutputFormat::Wav).unwrap();

        assert_eq!(fmt_chunk(&out), (18, 0x0003, 16_000, 32));
        assert!(has_fact_chunk(&out), "non-PCM WAV needs a fact chunk");
        assert_eq!(decode_f32(&out), pcm, "float input re-encodes exactly");
    }

    #[test]
    fn stereo_sidecar_input_is_mixed_down_to_mono() {
        // The downmix is defensive — no shipping voice returns stereo — but it
        // silently doubles the sample count if it ever regresses.
        let interleaved: Vec<i16> = vec![16384, -16384, 8192, 8192, 0, 32766];
        let out =
            super::transcode_to(&pcm16_wav(&interleaved, 24_000, 2), OutputFormat::Wav).unwrap();

        let decoded = decode_f32(&out);
        let expected = [0.0, 8192.0 / 32_768.0, 16383.0 / 32_768.0];
        assert_eq!(decoded.len(), 3, "three frames in, three samples out");
        for (i, (got, want)) in decoded.iter().zip(expected).enumerate() {
            assert!((got - want).abs() < 1e-6, "frame {i}: {got} vs {want}");
        }
    }

    #[test]
    fn wav_normalization_preserves_the_sidecar_audio() {
        let pcm: Vec<i16> = (0..2048)
            .map(|i| ((i as f32 * 0.05).sin() * 30_000.0) as i16)
            .collect();
        let out = super::transcode_to(&pcm16_wav(&pcm, 24_000, 1), OutputFormat::Wav).unwrap();

        let decoded = decode_f32(&out);
        assert_eq!(decoded.len(), pcm.len());
        for (i, (got, want)) in decoded.iter().zip(&pcm).enumerate() {
            let want = *want as f32 / 32_768.0;
            assert!((got - want).abs() < 1e-6, "sample {i}: {got} vs {want}");
        }
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
    fn dropped_ipa_mid_run_splices_the_surrounding_text_into_one_call() {
        let log = RefCell::new(Vec::new());
        let synth = recording_synth(&log);
        let mut out = Vec::new();
        let segs = [
            Segment::Text("before ".into()),
            Segment::Ipa("həˈloʊ".into()),
            Segment::Text(" after".into()),
        ];
        walk(&synth, &segs, 1.0, &mut out);
        let calls = log.borrow();
        assert_eq!(calls.len(), 1, "the dropped Ipa must not split the run");
        assert_eq!(calls[0].0, "before after");
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
