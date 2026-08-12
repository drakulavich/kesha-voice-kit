#[cfg(all(feature = "system_diarize", target_os = "macos"))]
pub(crate) mod diarize;
mod itn;
mod options;

pub use options::TranscribeOptionsBuilder;

use anyhow::{Context, Result};
use serde::Serialize;
use std::path::Path;
use std::time::Instant;

use crate::audio;
use crate::backend;
use crate::backend::TranscriptionChunk;
use crate::coded_bail;
use crate::errors::ErrorCode;
use crate::models;
use crate::vad::{VadConfig, VadDetector, SAMPLE_RATE as VAD_SAMPLE_RATE};
use crate::{dtrace, dtrace_json};

/// Capability-flag string surfaced via `--capabilities-json`. Single source of
/// truth so the engine, the TS CLI gate, and the integration tests can't drift.
pub const TRANSCRIBE_SEGMENTS_FEATURE: &str = "transcribe.segments";

/// Capability flag surfaced via `--capabilities-json` when the engine ships
/// with FluidAudio diarization. Only true on darwin-arm64 release builds
/// that include the `system_diarize` feature. Closes #199 angle D.
#[cfg_attr(not(feature = "system_diarize"), allow(dead_code))]
pub const TRANSCRIBE_DIARIZE_FEATURE: &str = "transcribe.diarize";

/// Capability flag for the opt-in written-form (ITN) pass on transcript text.
/// Unlike [`TRANSCRIBE_DIARIZE_FEATURE`] this is not backend-gated — the pass
/// is pure Rust and behaves identically on CoreML and ONNX, so the flag exists
/// for engine-version skew only (#710).
pub const TRANSCRIBE_ITN_FEATURE: &str = "transcribe.itn";

/// Capability flag for per-word timings inside `--json --timestamps` segments.
/// Backend-gated: only the ONNX TDT decoder retains the emission frame of each
/// token today, so CoreML builds omit both the flag and the `words` key (#720).
#[cfg_attr(feature = "coreml", allow(dead_code))]
pub const TRANSCRIBE_WORDS_FEATURE: &str = "transcribe.words";

/// Duration at which the `Auto` VAD mode flips to VAD preprocessing.
/// Voice messages (<30 s) and short clips don't benefit; meetings and
/// lectures (>2 min) do.
const AUTO_VAD_MIN_SECONDS: f32 = 120.0;

/// File-size floor below which `Auto` mode skips the duration probe entirely.
/// Any audio <120 s at a plausible bitrate weighs well over this threshold;
/// the guard keeps the hot path cheap for voice messages and bounds MP3
/// worst-case probe cost (symphonia scans the file when a Xing header is
/// absent — can reach seconds on large CBR files).
const AUTO_VAD_MIN_FILE_SIZE: u64 = 200_000;

/// Conservative full-file ASR ceiling. NVIDIA's Parakeet model cards describe
/// full-attention single-pass inference as duration/memory-bound, with ~24
/// minutes as the upstream guidance before local attention or buffered
/// inference becomes the safe path. Kesha's local backends do not expose local
/// attention yet, so explicit `--no-vad` fails above this and Auto mode uses
/// fixed-window chunking when VAD is unavailable.
const FULL_FILE_SINGLE_PASS_MAX_SECONDS: f32 = 24.0 * 60.0;

/// Fixed-window fallback used when long audio has no VAD-backed path. Keep
/// windows comfortably below the single-pass ceiling; overlap gives the model
/// a little boundary context, and output timestamps are trimmed back to
/// non-overlapping ranges.
const FIXED_CHUNK_SECONDS: f32 = 10.0 * 60.0;
const FIXED_CHUNK_OVERLAP_SECONDS: f32 = 5.0;

/// Shortest run of words allowed to anchor a seam splice. Below this a match
/// is as likely to be a coincidental phrase repeat as the re-transcribed
/// overlap, and splicing on it would drop real speech.
const SEAM_MIN_ANCHOR_WORDS: usize = 4;

/// Generous speaking rate used to size how many words on either side of a seam
/// may take part in a splice. Over-estimating only widens a bounded scan;
/// under-estimating would leave the overlap in the transcript twice.
const SEAM_WORDS_PER_SECOND: f32 = 3.0;

/// How many leading words of the new chunk an anchor may start past. A window
/// with no left context mangles its first token or two, but anything deeper is
/// a later phrase recurring — anchoring there deletes the real speech before it.
const SEAM_MAX_ANCHOR_SKIP_WORDS: usize = 3;

/// Caller-requested VAD behaviour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadMode {
    /// Use VAD when the audio looks long enough and the model is installed,
    /// otherwise skip it silently (with a one-time stderr hint if it would
    /// have helped but the model is missing).
    Auto,
    /// Force VAD on. Errors if the model isn't installed.
    On,
    /// Force VAD off regardless of duration or install state.
    Off,
}

impl VadMode {
    /// Derive the mode from the two mutually-exclusive CLI flags. `(true, true)`
    /// should be caught by clap's `conflicts_with` before we get here; we still
    /// resolve it deterministically (prefer `On`) rather than panicking.
    pub fn from_flags(vad: bool, no_vad: bool) -> Self {
        match (vad, no_vad) {
            (true, _) => Self::On,
            (_, true) => Self::Off,
            _ => Self::Auto,
        }
    }
}

/// `Default` lives with the type it's for. `TranscribeOptions::default()`
/// uses `Auto` so it matches the historical text-only `transcribe(_, Auto)`
/// behavior.
impl Default for VadMode {
    fn default() -> Self {
        Self::Auto
    }
}

/// One word of a segment, on the same file-relative clock as
/// [`TranscriptionSegment::start`] — a word span always lies inside its segment.
///
/// Times come from the ASR's own frame grid, so they are quantised to that grid
/// (0.08 s on Parakeet TDT) and `end` is a per-token duration prediction rather
/// than the next word's `start`: consecutive spans may overlap and are not a
/// partition of the segment. `word` is what the decoder emitted, punctuation
/// attached, so the count needn't match the words a human hears (#720).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WordTiming {
    pub word: String,
    pub start: f32,
    pub end: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptionSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
    /// Cluster ID from speaker diarization. `None` when `--speakers` was not
    /// requested (default) or when diarization could not assign a speaker
    /// to this segment. Stable within one `--json --timestamps --speakers`
    /// invocation; not stable across files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<u32>,
    /// Per-word timings, absent on backends that cannot produce them. Never
    /// `null` and never `[]` for "unsupported" — the `transcribe.words`
    /// capability says whether this build can emit it at all (#720).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<WordTiming>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptionOutput {
    pub text: String,
    pub segments: Vec<TranscriptionSegment>,
}

/// Canonical input shape for [`transcribe_with_options`]. Replaced three
/// per-feature top-level wrappers (`transcribe` / `transcribe_output` /
/// `transcribe_output_with_speakers`) that grew with each new flag (#267 F5).
///
/// New flags should land here as fields, not as a new top-level wrapper.
///
/// Prefer [`TranscribeOptionsBuilder`] over direct struct construction —
/// the builder lifts the `with_speakers => with_segments` constraint into
/// the type system (F18). The runtime [`anyhow::ensure!`] guard inside
/// [`transcribe_with_options`] still fires on direct misuse.
#[derive(Debug, Clone, Copy, Default)]
pub struct TranscribeOptions {
    /// VAD preprocessing selector (Auto / On / Off).
    pub mode: VadMode,
    /// Populate `TranscriptionOutput::segments` with per-utterance
    /// `(start, end, text)` triples. Text-only callers can leave this
    /// `false` to skip the duration probe on the non-VAD plain path.
    pub with_segments: bool,
    /// Run the FluidAudio diarization post-step and label each segment
    /// with its `speaker` cluster id. Currently darwin-arm64 only;
    /// `transcribe_with_options` returns an error on other platforms.
    pub with_speakers: bool,
    /// Rewrite spoken-form numbers, money, dates and times in the transcript
    /// to written form. Off by default; segment timing is unaffected (#710).
    pub itn: bool,
}

/// Pure decision function so the auto-trigger rules can be unit-tested
/// without ONNX, disk, or symphonia in the loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VadDecision {
    Vad,
    Plain,
    PlainWithHint,
    ChunkedWithHint,
}

fn decide(mode: VadMode, duration_s: Option<f32>, vad_installed: bool) -> VadDecision {
    match mode {
        VadMode::On => VadDecision::Vad,
        VadMode::Off => VadDecision::Plain,
        VadMode::Auto => match duration_s {
            Some(d) if d >= AUTO_VAD_MIN_SECONDS && vad_installed => VadDecision::Vad,
            Some(d) if d >= FULL_FILE_SINGLE_PASS_MAX_SECONDS => VadDecision::ChunkedWithHint,
            Some(d) if d >= AUTO_VAD_MIN_SECONDS => VadDecision::PlainWithHint,
            // Unknown duration or short clip → plain, no hint.
            _ => VadDecision::Plain,
        },
    }
}

/// Speaker labels attach to ASR segments, so diarization needs a real
/// segmentation: without VAD the transcript is one whole-file segment and the
/// coverage guard degenerates to a coin flip on multi-speaker audio (#768).
/// An explicit `--no-vad` is refused rather than silently overridden. Runs
/// before any model resolution so an invalid flag pair reads as invalid even
/// when nothing is installed.
fn reject_no_vad_with_speakers(mode: VadMode) -> Result<()> {
    if mode == VadMode::Off {
        coded_bail!(
            ErrorCode::InvalidArg,
            "--speakers cannot be combined with --no-vad: diarization labels VAD-windowed \
             speech segments, and --no-vad leaves the whole file as one segment with nothing \
             to label. Drop --no-vad (VAD engages automatically for --speakers), or drop \
             --speakers to get a plain full-file transcript."
        );
    }
    Ok(())
}

/// Diarization forces VAD windowing regardless of duration, overriding the
/// auto-VAD duration threshold (#768).
fn vad_mode_for_diarization(vad_installed: bool) -> Result<VadMode> {
    if !vad_installed {
        coded_bail!(
            ErrorCode::ModelMissing,
            "speaker diarization needs the VAD model, which is not installed: --speakers \
             windows the audio with Silero VAD so each speech span can be labeled. \
             Run `kesha install --vad`."
        );
    }
    Ok(VadMode::On)
}

/// Canonical transcribe entry. New flags should land in [`TranscribeOptions`]
/// instead of growing a new top-level wrapper.
///
/// `opts.with_segments` gates whether the non-VAD plain path resolves audio
/// duration to attach a single whole-file segment. Text-only callers skip it
/// so they never pay the decode fallback that streaming Ogg/Opus without a
/// frame count requires (#767). The VAD path always builds segments cheaply
/// (per-span boundaries already in hand from VAD output).
///
/// `opts.with_speakers` preflights diarization prerequisites before ASR starts,
/// then runs the diarization post-step after ASR completes. On darwin-arm64
/// with the `system_diarize` feature it invokes `diarize::run` +
/// `diarize::merge_into`; on all other platforms it returns a clear error
/// pointing at #199.
pub fn transcribe_with_options(
    audio_path: &str,
    opts: &TranscribeOptions,
) -> Result<TranscriptionOutput> {
    let TranscribeOptions {
        mode,
        with_segments: timestamps_required,
        with_speakers: speakers_required,
        itn: itn_required,
    } = *opts;
    // Reject the `{with_speakers: true, with_segments: false}` combination
    // explicitly. On the plain path `transcribe_plain` returns an empty
    // `segments` vec when `timestamps_required == false`, and
    // `diarize::merge_into` would then drop every speaker label silently
    // (Greptile P1 on #290). Before this guard the combination was
    // unreachable: the three legacy wrappers always paired the two flags.
    // Now that `transcribe_with_options` is public, surface the misuse.
    anyhow::ensure!(
        !speakers_required || timestamps_required,
        "TranscribeOptions::with_speakers requires with_segments=true \
         (speaker labels attach to per-utterance segments; without segments \
         there is nowhere to put them)"
    );
    if speakers_required {
        reject_no_vad_with_speakers(mode)?;
    }
    // Bail cleanly on unsupported containers / video-only files BEFORE
    // paying the 25 s+ ANE cold-load tax in `ensure_asr_installed` +
    // backend construction. Symphonia's error message names the
    // container and the failure mode; without this check the user sees
    // the FluidAudio wrapper's cryptic "Swift bridge error: Transcription
    // failed" ~25 s later (v1.16.0 validation against
    // `~/Downloads/assets_demo.webm` + three Zoom m4a samples). Cheap:
    // container-header read only, no frame scan.
    audio::ensure_audio_track(audio_path)?;

    #[cfg(all(feature = "system_diarize", target_os = "macos"))]
    let diarize_model_path = if speakers_required {
        Some(resolve_diarize_model_path().context("speaker diarization requires a model path")?)
    } else {
        None
    };

    #[cfg(not(all(feature = "system_diarize", target_os = "macos")))]
    if speakers_required {
        anyhow::bail!(
            "speaker diarization is currently darwin-arm64 only.\n\
             Tracked at https://github.com/drakulavich/kesha-voice-kit/issues/199.",
        );
    }

    let vad_dir = models::model_dir(models::ModelKind::Vad)
        .to_string_lossy()
        .into_owned();
    let vad_installed = models::is_cached(models::ModelKind::Vad);
    let mode = if speakers_required {
        vad_mode_for_diarization(vad_installed)?
    } else {
        mode
    };

    let model_dir = ensure_asr_installed()?;

    // `Auto` needs a duration probe for routing. `Off` probes too so explicit
    // full-file ASR can fail before loading a backend for media beyond the
    // duration/memory-bound single-pass contract.
    let duration = match mode {
        VadMode::Auto | VadMode::Off => probe_duration_if_plausible(audio_path),
        _ => None,
    };
    validate_plain_transcribe_safety(mode, duration, vad_installed)?;
    let decision = decide(mode, duration, vad_installed);
    dtrace!(
        "asr::mode={mode:?} duration={:?} vad_installed={vad_installed} decision={decision:?}",
        duration
    );

    #[cfg_attr(
        not(all(feature = "system_diarize", target_os = "macos")),
        allow(unused_mut)
    )]
    let mut output = match decision {
        VadDecision::Vad => {
            transcribe_via_vad(audio_path, &model_dir, &vad_dir, VadConfig::default())
        }
        // Pass the already-probed duration through so `resolve_segment_duration`
        // doesn't re-open the file (#248). On `On`/`Off` modes we didn't probe,
        // so it's `None` and the helper does the work.
        VadDecision::Plain => {
            transcribe_plain(audio_path, &model_dir, duration, timestamps_required)
        }
        VadDecision::PlainWithHint => {
            let secs = duration.unwrap_or(0.0);
            eprintln!(
                "hint: audio is {secs:.0}s; `kesha install --vad` would improve long-audio accuracy"
            );
            transcribe_plain(audio_path, &model_dir, duration, timestamps_required)
        }
        VadDecision::ChunkedWithHint => {
            let secs = duration.unwrap_or(0.0);
            eprintln!(
                "hint: audio is {secs:.0}s; VAD is not installed, so Kesha is using fixed-window ASR chunks. \
                 Run `kesha install --vad` for better long-audio boundaries."
            );
            transcribe_chunked(audio_path, &model_dir, timestamps_required)
        }
    }?;

    #[cfg(all(feature = "system_diarize", target_os = "macos"))]
    {
        if let Some(model_path) = diarize_model_path {
            let spans = diarize::run(
                std::path::Path::new(audio_path),
                &model_path,
                &output.segments,
                duration,
            )
            .context("speaker diarization failed")?;
            output.segments = diarize::merge_into(output.segments, &spans);
        }
    }

    Ok(finalize_output(output, timestamps_required, itn_required))
}

/// Post-processing tail shared by every ASR path, run after diarization —
/// diarization reads only segment spans, so the two are order-independent.
fn finalize_output(
    mut output: TranscriptionOutput,
    timestamps_required: bool,
    itn_required: bool,
) -> TranscriptionOutput {
    // The VAD path returns its speech spans even when segments weren't asked
    // for; plain and chunked already return none. Normalising here makes
    // `with_segments: false` mean the same thing everywhere, so text-only ITN
    // always sees the whole transcript instead of per-span text that can split
    // a number phrase across segments (#710).
    if !timestamps_required {
        output.segments.clear();
    }
    if itn_required {
        output = itn::normalize_output(output);
    }
    output
}

/// Shared by plain and chunked paths to avoid duplicate timing+logging+create_backend blocks.
fn create_timed_backend(model_dir: &str) -> Result<Box<dyn backend::TranscribeBackend>> {
    let t0 = Instant::now();
    let be = backend::create_backend(model_dir)?;
    let dt_ms = t0.elapsed().as_millis() as u64;
    dtrace!("asr::backend_loaded dt={dt_ms}ms");
    dtrace_json!("asr.backend_loaded", { "dt_ms": dt_ms });
    Ok(be)
}

fn join_segment_texts(segments: &[TranscriptionSegment]) -> String {
    segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn transcribe_plain(
    audio_path: &str,
    model_dir: &str,
    duration: Option<f32>,
    timestamps_required: bool,
) -> Result<TranscriptionOutput> {
    let mut be = create_timed_backend(model_dir)?;
    let t1 = Instant::now();
    let chunk = be.transcribe(audio_path)?;
    let text = chunk.text;
    dtrace!(
        "asr::transcribe.end dt={}ms chars={}",
        t1.elapsed().as_millis(),
        text.chars().count()
    );
    // Text-only callers and blank transcripts have nothing to timestamp, so
    // they skip duration resolution and its decode fallback entirely.
    let segments = if timestamps_required && !text.trim().is_empty() {
        let dur = resolve_segment_duration(audio_path, duration)?;
        single_segment(0.0, dur, &text, chunk.words)
    } else {
        vec![]
    };
    Ok(TranscriptionOutput { segments, text })
}

fn transcribe_chunked(
    audio_path: &str,
    model_dir: &str,
    timestamps_required: bool,
) -> Result<TranscriptionOutput> {
    let t_audio = Instant::now();
    let samples = audio::load_audio(audio_path)?;
    dtrace!(
        "chunked::audio_loaded dt={}ms samples={}",
        t_audio.elapsed().as_millis(),
        samples.len()
    );

    let mut be = create_timed_backend(model_dir)?;

    transcribe_chunked_samples(&samples, &mut |slice| be.transcribe_samples(slice)).map(
        |mut output| {
            if !timestamps_required {
                output.segments.clear();
            }
            output
        },
    )
}

/// VAD-preprocessed transcription: segment the audio with Silero VAD,
/// transcribe each speech span independently, stitch with spaces.
///
/// All-silence inputs fall back to a single full-file pass for short/medium
/// clips, or fixed-window chunking for very long audio, so a misconfigured
/// threshold never silently drops input and never forces unsafe full-file ASR.
fn transcribe_via_vad(
    audio_path: &str,
    model_dir: &str,
    vad_dir: &str,
    cfg: VadConfig,
) -> Result<TranscriptionOutput> {
    if !models::is_cached_in(models::ModelKind::Vad, std::path::Path::new(vad_dir)) {
        anyhow::bail!(
            "Error: VAD model not installed\n\n\
             Please run: kesha install --vad"
        );
    }

    let t_audio = Instant::now();
    let samples = audio::load_audio(audio_path)?;
    dtrace!(
        "vad::audio_loaded dt={}ms samples={}",
        t_audio.elapsed().as_millis(),
        samples.len()
    );

    let t_vad = Instant::now();
    let vad_path = Path::new(vad_dir).join("silero_vad.onnx");
    let mut vad = VadDetector::load(&vad_path).context("load Silero VAD")?;
    let spans = vad.detect_segments(&samples, cfg)?;
    dtrace!(
        "vad::detect dt={}ms segments={}",
        t_vad.elapsed().as_millis(),
        spans.len()
    );

    let mut be = backend::create_backend(model_dir)?;

    if spans.is_empty() {
        let min_speech_samples =
            (cfg.min_speech_ms as u64 * VAD_SAMPLE_RATE as u64 / 1000) as usize;
        // #275 D7: surface the input duration + threshold the segmenter
        // saw when it concluded "no speech". With the prior `vad::detect
        // segments=0` line, this gives the user enough to tell "the audio
        // is actually silent" from "the threshold is too aggressive".
        let total_secs = samples.len() as f32 / VAD_SAMPLE_RATE as f32;
        dtrace!(
            "vad::all_silence total_secs={:.1} min_speech_ms={} threshold={:.2}",
            total_secs,
            cfg.min_speech_ms,
            cfg.threshold
        );
        if samples.len() >= min_speech_samples {
            if total_secs >= FULL_FILE_SINGLE_PASS_MAX_SECONDS {
                eprintln!(
                    "warning: VAD produced no speech segments for very long audio; using fixed-window ASR chunks instead of unsafe full-file ASR"
                );
                return transcribe_chunked_samples(&samples, &mut |slice| {
                    be.transcribe_samples(slice)
                });
            } else {
                eprintln!(
                    // No flag advice here: --no-vad is refused under --speakers (#768).
                    "warning: VAD produced no speech segments; transcribing full file (the audio may be silent, or its speech quieter than the VAD threshold)"
                );
            }
        }
        let chunk = be.transcribe_samples(&samples)?;
        let text = chunk.text;
        // Reuse the duration we already computed for the dtrace above
        // (Greptile follow-up on #282 — was a redundant float divide).
        return Ok(TranscriptionOutput {
            segments: single_segment(0.0, total_secs, &text, chunk.words),
            text,
        });
    }

    let output_segments =
        build_vad_output_segments(&spans, &samples, VAD_SAMPLE_RATE as f32, |slice| {
            be.transcribe_samples(slice)
        });

    let text = join_segment_texts(&output_segments);

    Ok(TranscriptionOutput {
        text,
        segments: output_segments,
    })
}

/// Build per-span [`TranscriptionSegment`]s from a sequence of VAD spans.
/// Pure function: takes the spans + a transcribe callback so unit tests can
/// drive it without spinning up an ONNX model. Empty / failed spans are
/// dropped (with a stderr warning on failure) so the output preserves both
/// the monotonic-start invariant of the input and the `end > start` shape.
fn build_vad_output_segments<F>(
    spans: &[(f32, f32)],
    samples: &[f32],
    sr: f32,
    mut transcribe_span: F,
) -> Vec<TranscriptionSegment>
where
    F: FnMut(&[f32]) -> Result<TranscriptionChunk>,
{
    let mut out = Vec::with_capacity(spans.len());
    for &(start_s, end_s) in spans {
        let start = (start_s * sr) as usize;
        let end = ((end_s * sr) as usize).min(samples.len());
        if start >= end {
            continue;
        }
        let slice = &samples[start..end];
        let t = Instant::now();
        match transcribe_span(slice) {
            Ok(chunk) => {
                let text = chunk.text;
                dtrace!(
                    "vad::segment dt={}ms range={:.2}-{:.2}s chars={}",
                    t.elapsed().as_millis(),
                    start_s,
                    end_s,
                    text.chars().count()
                );
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    out.push(TranscriptionSegment {
                        start: start_s,
                        end: end_s,
                        text: trimmed.to_string(),
                        speaker: None,
                        words: words_onto_segment(chunk.words, start_s, start_s, end_s),
                    });
                }
            }
            Err(e) => {
                // One failing segment shouldn't kill the whole transcript.
                eprintln!(
                    "warning: VAD segment {:.2}-{:.2}s failed: {e}",
                    start_s, end_s
                );
            }
        }
    }
    out
}

fn transcribe_chunked_samples<F>(
    samples: &[f32],
    transcribe_chunk: &mut F,
) -> Result<TranscriptionOutput>
where
    F: FnMut(&[f32]) -> Result<TranscriptionChunk>,
{
    let segments = build_chunked_output_segments(
        samples,
        VAD_SAMPLE_RATE as f32,
        FIXED_CHUNK_SECONDS,
        FIXED_CHUNK_OVERLAP_SECONDS,
        transcribe_chunk,
    )?;
    let text = join_segment_texts(&segments);
    Ok(TranscriptionOutput { text, segments })
}

fn build_chunked_output_segments<F>(
    samples: &[f32],
    sr: f32,
    chunk_seconds: f32,
    overlap_seconds: f32,
    mut transcribe_chunk: F,
) -> Result<Vec<TranscriptionSegment>>
where
    F: FnMut(&[f32]) -> Result<TranscriptionChunk>,
{
    let windows = fixed_chunk_windows(samples.len(), sr, chunk_seconds, overlap_seconds);
    let mut out: Vec<TranscriptionSegment> = Vec::with_capacity(windows.len());
    let seam_budget = seam_word_budget(overlap_seconds);
    let mut failures = 0usize;
    let mut first_failure: Option<String> = None;

    for window in windows {
        let slice = &samples[window.input_start..window.input_end];
        let t = Instant::now();
        match transcribe_chunk(slice) {
            Ok(chunk) => {
                let text = chunk.text;
                dtrace!(
                    "chunked::segment dt={}ms range={:.2}-{:.2}s chars={}",
                    t.elapsed().as_millis(),
                    window.output_start_s,
                    window.output_end_s,
                    text.chars().count()
                );
                // Only the previous emitted segment physically overlaps this
                // window, and it was already trimmed back to the seam — so its
                // tail is exactly the pre-seam text this chunk re-transcribes.
                let previous = out.last().map(|s| s.text.as_str()).unwrap_or("");
                let full = text.trim();
                let trimmed = trim_repeated_prefix(previous, full, seam_budget);
                if trimmed.is_empty() {
                    continue;
                }
                // The trim drops whole words off the front; words are one per
                // whitespace-separated word of the same text, so the same count
                // comes off the front of the timings or the two disagree (#720).
                let dropped = full
                    .split_whitespace()
                    .count()
                    .saturating_sub(trimmed.split_whitespace().count());
                let words = chunk.words.map(|w| w.into_iter().skip(dropped).collect());
                out.push(TranscriptionSegment {
                    start: window.output_start_s,
                    end: window.output_end_s,
                    text: trimmed.to_string(),
                    speaker: None,
                    words: words_onto_segment(
                        words,
                        window.input_start as f32 / sr,
                        window.output_start_s,
                        window.output_end_s,
                    ),
                });
            }
            Err(e) => {
                failures += 1;
                if first_failure.is_none() {
                    first_failure = Some(e.to_string());
                }
                eprintln!(
                    "warning: fixed-window ASR chunk {:.2}-{:.2}s failed: {e}",
                    window.output_start_s, window.output_end_s
                );
            }
        }
    }

    if out.is_empty() && failures > 0 {
        let first = first_failure.unwrap_or_else(|| "unknown error".to_string());
        anyhow::bail!("all fixed-window ASR chunks failed; first failure: {first}");
    }

    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ChunkWindow {
    input_start: usize,
    input_end: usize,
    output_start_s: f32,
    output_end_s: f32,
}

fn fixed_chunk_windows(
    total_samples: usize,
    sr: f32,
    chunk_seconds: f32,
    overlap_seconds: f32,
) -> Vec<ChunkWindow> {
    if total_samples == 0 || sr <= 0.0 || chunk_seconds <= 0.0 {
        return vec![];
    }

    let chunk_samples = ((chunk_seconds * sr).round() as usize).max(1);
    let overlap_samples =
        ((overlap_seconds.max(0.0) * sr).round() as usize).min(chunk_samples.saturating_sub(1));
    let step = chunk_samples.saturating_sub(overlap_samples).max(1);

    let mut windows = Vec::new();
    let mut start = 0usize;
    while start < total_samples {
        let end = start.saturating_add(chunk_samples).min(total_samples);
        let output_start = if windows.is_empty() {
            start
        } else {
            start.saturating_add(overlap_samples).min(end)
        };
        if output_start < end {
            windows.push(ChunkWindow {
                input_start: start,
                input_end: end,
                output_start_s: output_start as f32 / sr,
                output_end_s: end as f32 / sr,
            });
        }
        if end == total_samples {
            break;
        }
        start = start.saturating_add(step);
    }
    windows
}

/// How many words on either side of a seam may take part in a splice.
fn seam_word_budget(overlap_seconds: f32) -> usize {
    ((overlap_seconds.max(0.0) * SEAM_WORDS_PER_SECOND * 2.0).ceil() as usize)
        .max(SEAM_MIN_ANCHOR_WORDS * 2)
}

/// One whitespace-delimited token plus its case- and punctuation-folded
/// comparison key. `end` spans the raw token, so splicing just past a matched
/// word also carries its trailing punctuation.
struct SeamWord {
    end: usize,
    key: String,
}

fn seam_words(text: &str) -> Vec<SeamWord> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let push = |start: usize, end: usize, out: &mut Vec<SeamWord>| {
        let key = text[start..end]
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase();
        if !key.is_empty() {
            out.push(SeamWord { end, key });
        }
    };
    for (i, c) in text.char_indices() {
        match (c.is_whitespace(), start) {
            (true, Some(s)) => {
                push(s, i, &mut out);
                start = None;
            }
            (false, None) => start = Some(i),
            _ => {}
        }
    }
    if let Some(s) = start {
        push(s, text.len(), &mut out);
    }
    out
}

/// Drop the leading part of `current` that re-transcribes audio `previous`
/// already covered, returning the rest of `current` verbatim.
///
/// Matching is word-granular on purpose. A byte-granular cut splits words at
/// the seam ("operational" spliced onto "…the operation" leaves "al") and can
/// swallow a whole word whose spelling merely ends the previous chunk
/// ("…the cooperation" eats the "operation" that follows) — the two failure
/// shapes upstream FluidAudio fixed in its own seam merge (#683/#688/#759).
/// When nothing anchors, `current` is returned untouched: a duplicated seam
/// phrase is recoverable by a reader, a dropped one is not.
fn trim_repeated_prefix<'a>(previous: &str, current: &'a str, budget: usize) -> &'a str {
    let current = current.trim_start();
    let all_prev = seam_words(previous);
    let prev = &all_prev[all_prev.len().saturating_sub(budget)..];
    let cur = seam_words(current);

    if let Some(rest) = splice_after_anchor(prev, &cur, current, budget) {
        return rest;
    }
    // A window boundary can cut the previous chunk off mid-word ("…for the new
    // author" where the audio says "authentication"), which makes every anchor
    // ending in that fragment unmatchable. Retry without it rather than emit
    // the whole overlap twice; the fragment itself stays in the transcript.
    if prev.len() > SEAM_MIN_ANCHOR_WORDS {
        if let Some(rest) = splice_after_anchor(&prev[..prev.len() - 1], &cur, current, budget) {
            return rest;
        }
    }
    current
}

/// Find the longest run of words that both ends `prev` and starts within the
/// first few words of `cur`, and return `current` from just past it.
fn splice_after_anchor<'a>(
    prev: &[SeamWord],
    cur: &[SeamWord],
    current: &'a str,
    budget: usize,
) -> Option<&'a str> {
    let limit = budget.min(cur.len());
    let max_n = prev.len().min(limit);
    if max_n < SEAM_MIN_ANCHOR_WORDS {
        return None;
    }
    for n in (SEAM_MIN_ANCHOR_WORDS..=max_n).rev() {
        let anchor = &prev[prev.len() - n..];
        // One word repeated matches anywhere inside its own run, so it cannot
        // say where the overlap ends.
        if anchor.iter().all(|w| w.key == anchor[0].key) {
            continue;
        }
        for j in 0..=(limit - n).min(SEAM_MAX_ANCHOR_SKIP_WORDS) {
            if cur[j..j + n]
                .iter()
                .map(|w| &w.key)
                .eq(anchor.iter().map(|w| &w.key))
            {
                return Some(current[cur[j + n - 1].end..].trim_start());
            }
        }
    }
    None
}

/// Re-uses duration from the `Auto` probe-and-decide step (#248) to avoid re-opening the file,
/// then the cheap header probe, then a decode-and-measure for containers the probe can't answer.
/// Split from `transcribe_plain` for testability without an ASR backend.
fn resolve_segment_duration(audio_path: &str, hint: Option<f32>) -> Result<f32> {
    if let Some(d) = hint {
        return Ok(d);
    }
    let probed = audio::probe_duration_seconds(audio_path).with_context(|| {
        format!("failed to probe audio duration for timestamped segments: {audio_path}")
    })?;
    match probed {
        Some(d) => Ok(d),
        // #767: streaming containers declare no frame count, so the cheap probe
        // reports "unknown" — decode to measure rather than failing the request.
        None => audio::measure_duration_seconds(audio_path).with_context(|| {
            format!("failed to measure audio duration for timestamped segments: {audio_path}")
        }),
    }
}

fn single_segment(
    start: f32,
    end: f32,
    text: &str,
    words: Option<Vec<WordTiming>>,
) -> Vec<TranscriptionSegment> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    vec![TranscriptionSegment {
        start,
        end,
        text: trimmed.to_string(),
        speaker: None,
        words: words_onto_segment(words, start, start, end),
    }]
}

/// Move slice-local word times onto the file clock and clamp them into the
/// segment carrying them. Backends time words against the samples they were
/// handed, so every segmenting path owes this offset; the clamp keeps the
/// documented "a word span lies inside its segment" invariant true even when
/// the TDT duration head over-predicts past the end of the slice (#720).
fn words_onto_segment(
    words: Option<Vec<WordTiming>>,
    slice_start_s: f32,
    seg_start_s: f32,
    seg_end_s: f32,
) -> Option<Vec<WordTiming>> {
    words.map(|words| {
        words
            .into_iter()
            .map(|w| {
                let start = (w.start + slice_start_s).clamp(seg_start_s, seg_end_s);
                WordTiming {
                    word: w.word,
                    start,
                    end: (w.end + slice_start_s).clamp(start, seg_end_s),
                }
            })
            .collect()
    })
}

/// Probe audio duration for the `Auto` decision, gated on a cheap
/// file-size floor. Files too small to plausibly be ≥ 120 s skip the
/// probe entirely. Probe failures log via `dtrace!` and return `None`
/// — the decode path will surface the real error, if any, shortly.
fn probe_duration_if_plausible(path: &str) -> Option<f32> {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() < AUTO_VAD_MIN_FILE_SIZE {
            return None;
        }
    }
    match audio::probe_duration_seconds(path) {
        Ok(d) => d,
        Err(e) => {
            dtrace!("asr::probe_failed path={path} err={e}");
            None
        }
    }
}

fn validate_plain_transcribe_safety(
    mode: VadMode,
    duration_s: Option<f32>,
    vad_installed: bool,
) -> Result<()> {
    if mode != VadMode::Off {
        return Ok(());
    }

    let Some(duration_s) = duration_s else {
        return Ok(());
    };
    if duration_s < FULL_FILE_SINGLE_PASS_MAX_SECONDS {
        return Ok(());
    }

    let action = if vad_installed {
        "omit --no-vad so Kesha can segment the file with VAD"
    } else {
        "run `kesha install --vad`, then rerun without --no-vad"
    };
    anyhow::bail!(
        "refusing --no-vad for very long audio \
         (detected {duration_s:.0}s; single-pass limit is {FULL_FILE_SINGLE_PASS_MAX_SECONDS:.0}s). \
         Parakeet full-file ASR is duration/memory-bound; {action}."
    );
}

/// Resolve the diarization model path. Priority:
/// 1. `KESHA_DIARIZE_MODEL_PATH` env var (must point to an existing path).
/// 2. Default cache location populated by `kesha install --diarize`
///    (`~/.cache/kesha/models/diarize/SortformerNvidiaLow_v2.mlpackage`).
#[cfg(all(feature = "system_diarize", target_os = "macos"))]
fn resolve_diarize_model_path() -> Result<std::path::PathBuf> {
    if let Ok(env_path) = std::env::var("KESHA_DIARIZE_MODEL_PATH") {
        let p = std::path::PathBuf::from(env_path);
        if p.exists() {
            return Ok(p);
        }
        anyhow::bail!(
            "KESHA_DIARIZE_MODEL_PATH set but path does not exist: {}",
            p.display()
        );
    }

    let default = crate::models::model_dir(crate::models::ModelKind::Diarize);
    if crate::models::is_cached(crate::models::ModelKind::Diarize) {
        return Ok(default);
    }

    anyhow::bail!(
        "diarization model not found at {}. \
         Run `kesha install --diarize` (or set KESHA_DIARIZE_MODEL_PATH).",
        default.display()
    )
}

/// Returns the cached ASR model dir or bails with the install hint.
fn ensure_asr_installed() -> Result<String> {
    if !models::is_cached(models::ModelKind::Asr) {
        anyhow::bail!(
            "Error: No transcription models installed\n\n\
             Please run: kesha install"
        );
    }
    Ok(models::model_dir(models::ModelKind::Asr)
        .to_string_lossy()
        .into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Write a 16-bit PCM mono WAV of `seconds` silence. Symphonia's probe
    /// reads `n_frames` from the WAV data-chunk size, so these files produce
    /// real durations without needing an audio-generation crate. The actual
    /// samples are zeros — a proper file, not a spoofed header, so the
    /// file-size guard in `probe_duration_if_plausible` sees real bytes.
    fn write_silent_pcm16_wav(
        path: &std::path::Path,
        seconds: u32,
        sample_rate: u32,
    ) -> std::io::Result<()> {
        let n_samples = (seconds as u64) * (sample_rate as u64);
        let data_bytes = (n_samples * 2) as u32;
        let mut f = std::fs::File::create(path)?;
        f.write_all(b"RIFF")?;
        f.write_all(&(36u32 + data_bytes).to_le_bytes())?;
        f.write_all(b"WAVE")?;
        f.write_all(b"fmt ")?;
        f.write_all(&16u32.to_le_bytes())?;
        f.write_all(&1u16.to_le_bytes())?;
        f.write_all(&1u16.to_le_bytes())?;
        f.write_all(&sample_rate.to_le_bytes())?;
        f.write_all(&(sample_rate * 2).to_le_bytes())?;
        f.write_all(&2u16.to_le_bytes())?;
        f.write_all(&16u16.to_le_bytes())?;
        f.write_all(b"data")?;
        f.write_all(&data_bytes.to_le_bytes())?;
        let zeros = vec![0u8; (n_samples * 2) as usize];
        f.write_all(&zeros)?;
        Ok(())
    }

    #[test]
    fn probe_duration_reports_seconds_for_long_wav() {
        let tmp = tempfile::Builder::new()
            .prefix("kesha-auto-vad-long-")
            .suffix(".wav")
            .tempfile()
            .unwrap();
        write_silent_pcm16_wav(tmp.path(), 121, 16_000).unwrap();
        let duration = probe_duration_if_plausible(tmp.path().to_str().unwrap());
        let secs = duration.expect("long WAV should probe to Some duration");
        assert!((120.0..122.0).contains(&secs), "expected ~121s, got {secs}");
    }

    #[test]
    fn probe_skipped_for_files_below_size_guard() {
        // 1 s of 16 kHz PCM = ~32 KB, well below the 200 KB guard → probe skips symphonia entirely.
        let tmp = tempfile::Builder::new()
            .prefix("kesha-auto-vad-tiny-")
            .suffix(".wav")
            .tempfile()
            .unwrap();
        write_silent_pcm16_wav(tmp.path(), 1, 16_000).unwrap();
        assert!(std::fs::metadata(tmp.path()).unwrap().len() < AUTO_VAD_MIN_FILE_SIZE);
        assert_eq!(
            probe_duration_if_plausible(tmp.path().to_str().unwrap()),
            None,
        );
    }

    #[test]
    fn probe_returns_none_for_missing_or_invalid_file() {
        assert_eq!(
            probe_duration_if_plausible("/nonexistent/path/to/audio.wav"),
            None
        );
    }

    #[test]
    fn resolve_segment_duration_returns_hint_without_probing() {
        // #248: hint must be returned without re-opening the file; unparseable path errors if probe runs.
        let tmp = tempfile::Builder::new()
            .prefix("kesha-no-probe-")
            .suffix(".raw")
            .tempfile()
            .unwrap();
        std::fs::write(tmp.path(), b"not an audio container").unwrap();
        let dur = resolve_segment_duration(tmp.path().to_str().unwrap(), Some(7.5)).unwrap();
        assert_eq!(dur, 7.5);
    }

    #[test]
    fn resolve_segment_duration_errors_when_no_hint_and_probe_fails() {
        let tmp = tempfile::Builder::new()
            .prefix("kesha-no-duration-")
            .suffix(".raw")
            .tempfile()
            .unwrap();
        std::fs::write(tmp.path(), b"not an audio container").unwrap();

        let err = resolve_segment_duration(tmp.path().to_str().unwrap(), None)
            .expect_err("timestamped output should require a known duration when no caller value");
        assert!(
            err.to_string()
                .contains("failed to probe audio duration for timestamped segments"),
            "{err}"
        );
    }

    #[test]
    fn resolve_segment_duration_decodes_when_the_probe_reports_unknown() {
        // #767: containers that declare no frame count (every Ogg voice message
        // without an end-of-stream page) probed as `None`, which the caller
        // escalated into a fatal error instead of measuring the duration.
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone-no-eos.ogg");
        let path = fixture.to_string_lossy().into_owned();
        assert_eq!(
            audio::probe_duration_seconds(&path).unwrap(),
            None,
            "fixture no longer probes as unknown duration, so it stops covering #767"
        );

        let dur = resolve_segment_duration(&path, None)
            .expect("unknown probe duration must fall back to a decode, not fail");
        assert!(
            (0.48..0.55).contains(&dur),
            "expected the fixture's 0.51 s, got {dur}"
        );
    }

    #[test]
    fn no_vad_rejects_very_long_plain_runs() {
        let err = validate_plain_transcribe_safety(
            VadMode::Off,
            Some(FULL_FILE_SINGLE_PASS_MAX_SECONDS + 1.0),
            true,
        )
        .expect_err("very long --no-vad should be rejected before backend load");
        assert!(err.to_string().contains("refusing --no-vad"), "{err}");
        assert!(err.to_string().contains("omit --no-vad"), "{err}");
        assert!(err.to_string().contains("duration/memory-bound"), "{err}");
    }

    #[test]
    fn no_vad_rejection_points_at_vad_install_when_missing() {
        let err = validate_plain_transcribe_safety(
            VadMode::Off,
            Some(FULL_FILE_SINGLE_PASS_MAX_SECONDS + 1.0),
            false,
        )
        .expect_err("very long --no-vad should explain missing VAD");
        assert!(err.to_string().contains("kesha install --vad"), "{err}");
    }

    #[test]
    fn plain_safety_allows_short_or_auto_or_unknown_duration_runs() {
        assert!(
            validate_plain_transcribe_safety(
                VadMode::Off,
                Some(FULL_FILE_SINGLE_PASS_MAX_SECONDS - 1.0),
                true,
            )
            .is_ok(),
            "short --no-vad runs should still be allowed"
        );
        assert!(
            validate_plain_transcribe_safety(
                VadMode::Auto,
                Some(FULL_FILE_SINGLE_PASS_MAX_SECONDS + 1.0),
                true,
            )
            .is_ok(),
            "Auto mode should route through the VAD/chunked decision path"
        );
        assert!(
            validate_plain_transcribe_safety(VadMode::Off, None, true).is_ok(),
            "unknown duration should not fail before the backend can report the real error"
        );
    }

    #[test]
    fn fixed_windows_cover_new_audio_once_with_overlap_context() {
        let windows = fixed_chunk_windows(30, 10.0, 1.0, 0.2);
        assert_eq!(
            windows,
            vec![
                ChunkWindow {
                    input_start: 0,
                    input_end: 10,
                    output_start_s: 0.0,
                    output_end_s: 1.0,
                },
                ChunkWindow {
                    input_start: 8,
                    input_end: 18,
                    output_start_s: 1.0,
                    output_end_s: 1.8,
                },
                ChunkWindow {
                    input_start: 16,
                    input_end: 26,
                    output_start_s: 1.8,
                    output_end_s: 2.6,
                },
                ChunkWindow {
                    input_start: 24,
                    input_end: 30,
                    output_start_s: 2.6,
                    output_end_s: 3.0,
                },
            ]
        );
    }

    #[test]
    fn chunked_segments_trim_overlap_and_preserve_successful_chunks() {
        let samples = vec![0.0_f32; 30];
        let mut call = 0usize;
        let segs = build_chunked_output_segments(&samples, 10.0, 1.0, 0.2, |_slice| {
            call += 1;
            match call {
                1 => Ok("hello there over the wire".to_string().into()),
                2 => Ok("there over the wire world".to_string().into()),
                3 => anyhow::bail!("synthetic chunk failure"),
                4 => Ok("tail".to_string().into()),
                _ => unreachable!(),
            }
        })
        .expect("one failed chunk should not discard successful chunks");

        assert_eq!(segs.len(), 3);
        assert_eq!(segs[0].text, "hello there over the wire");
        assert_eq!(segs[1].text, "world");
        assert_eq!(segs[2].text, "tail");
        assert_eq!(segs[0].start, 0.0);
        assert_eq!(segs[1].start, 1.0);
        assert_eq!(segs[2].start, 2.6);
        for s in &segs {
            assert!(s.end > s.start, "{s:?} violates end > start");
        }
    }

    #[test]
    fn chunked_segments_error_when_every_chunk_fails() {
        let samples = vec![0.0_f32; 20];
        let err = build_chunked_output_segments(&samples, 10.0, 1.0, 0.2, |_slice| {
            anyhow::bail!("backend unavailable")
        })
        .expect_err("all failed chunks should still fail the command");
        assert!(
            err.to_string()
                .contains("all fixed-window ASR chunks failed"),
            "{err}"
        );
    }

    #[test]
    fn chunked_segments_skip_empty_transcriptions() {
        let samples = vec![0.0_f32; 12];
        let mut call = 0usize;
        let segs = build_chunked_output_segments(&samples, 10.0, 1.0, 0.2, |_slice| {
            call += 1;
            if call == 1 {
                Ok("   ".to_string().into())
            } else {
                Ok("spoken tail".to_string().into())
            }
        })
        .unwrap();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "spoken tail");
    }

    #[test]
    fn chunked_segments_handle_multibyte_transcripts_without_panicking() {
        let samples = vec![0.0_f32; 30];
        let long_ru = "я".repeat(300);
        let mut call = 0usize;
        let segs = build_chunked_output_segments(&samples, 10.0, 1.0, 0.2, |_slice| {
            call += 1;
            Ok(match call {
                1 => long_ru.clone(),
                2 => "привет".to_string(),
                3 => "мир".to_string(),
                _ => "конец".to_string(),
            }
            .into())
        })
        .expect("cyrillic transcripts must not panic while trimming overlap");

        assert_eq!(segs.len(), 4);
        assert_eq!(segs[0].text, long_ru);
        assert_eq!(segs[3].text, "конец");
    }

    #[test]
    fn chunked_segments_splice_a_cyrillic_seam() {
        let samples = vec![0.0_f32; 30];
        let mut call = 0usize;
        let segs = build_chunked_output_segments(&samples, 10.0, 1.0, 0.2, |_slice| {
            call += 1;
            Ok(match call {
                1 => "давайте начнём с обзора текущих задач",
                2 => "с обзора текущих задач а потом обсудим план",
                3 => "а потом обсудим план и на этом всё",
                _ => "и на этом всё спасибо",
            }
            .to_string()
            .into())
        })
        .expect("cyrillic seams must splice");

        let texts: Vec<&str> = segs.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "давайте начнём с обзора текущих задач",
                "а потом обсудим план",
                "и на этом всё",
                "спасибо",
            ]
        );
    }

    #[test]
    fn single_segment_trims_text_and_drops_empty() {
        assert_eq!(single_segment(0.0, 1.0, "  hi  ", None)[0].text, "hi");
        assert!(single_segment(0.0, 1.0, "  ", None).is_empty());
        assert!(single_segment(0.0, 1.0, "", None).is_empty());
    }

    #[test]
    fn vad_output_segments_preserve_input_ordering_and_invariants() {
        // Lock the VAD-path contract: for a sorted span list, output must
        // satisfy `end > start` per segment and `start[i+1] >= start[i]`
        // across segments (monotonic). #248.
        let spans = vec![(0.5, 1.5), (2.0, 3.5), (4.0, 5.2)];
        let samples = vec![0.0_f32; 16_000 * 6];
        let mut call = 0;
        let segs = build_vad_output_segments(&spans, &samples, 16_000.0, |_slice| {
            call += 1;
            Ok(format!("utterance {call}").into())
        });
        assert_eq!(segs.len(), 3);
        for s in &segs {
            assert!(s.end > s.start, "{s:?} violates end > start");
            assert!(!s.text.is_empty());
        }
        for w in segs.windows(2) {
            assert!(
                w[1].start >= w[0].start,
                "monotonic invariant violated: {w:?}"
            );
        }
    }

    #[test]
    fn vad_output_segments_skip_empty_transcriptions() {
        let spans = vec![(0.5, 1.5), (2.0, 3.5), (4.0, 5.2)];
        let samples = vec![0.0_f32; 16_000 * 6];
        let mut call = 0;
        let segs = build_vad_output_segments(&spans, &samples, 16_000.0, |_| {
            call += 1;
            if call == 2 {
                Ok(String::new().into())
            } else {
                Ok("hello".to_string().into())
            }
        });
        assert_eq!(segs.len(), 2, "empty transcription should be skipped");
        assert_eq!(segs[0].start, 0.5);
        assert_eq!(segs[1].start, 4.0);
    }

    #[test]
    fn vad_output_segments_skip_zero_length_spans() {
        // Spans where `start_s * sr >= samples_len` should be silently dropped
        // rather than panicking on the slice bounds.
        let spans = vec![(0.5, 0.5), (10.0, 11.0)];
        let samples = vec![0.0_f32; 16_000];
        let segs = build_vad_output_segments(&spans, &samples, 16_000.0, |_| {
            Ok(String::from("ignore").into())
        });
        assert_eq!(segs.len(), 0);
    }

    #[test]
    fn from_flags_maps_cli_arguments_to_modes() {
        assert_eq!(VadMode::from_flags(true, false), VadMode::On);
        assert_eq!(VadMode::from_flags(false, true), VadMode::Off);
        assert_eq!(VadMode::from_flags(false, false), VadMode::Auto);
        // Should-be-unreachable (clap rejects), but resolve deterministically.
        assert_eq!(VadMode::from_flags(true, true), VadMode::On);
    }

    #[test]
    fn speakers_engage_vad_windowing_at_any_duration() {
        // #768: Auto used to leave sub-120s audio as one whole-file segment, which
        // diarization cannot label.
        let mode = vad_mode_for_diarization(true).expect("speakers force VAD");
        assert_eq!(mode, VadMode::On);
        assert_eq!(decide(mode, Some(6.6), true), VadDecision::Vad);

        for allowed in [VadMode::Auto, VadMode::On] {
            reject_no_vad_with_speakers(allowed).expect("only --no-vad is refused");
        }
    }

    #[test]
    fn speakers_with_explicit_no_vad_are_refused_not_overridden() {
        let err = reject_no_vad_with_speakers(VadMode::Off)
            .expect_err("--no-vad + --speakers should fail early");
        let msg = format!("{err}");

        assert_eq!(crate::errors::code_of(&err), ErrorCode::InvalidArg);
        assert!(msg.contains("--speakers cannot be combined with --no-vad"));
        assert!(msg.contains("Drop --no-vad"));
    }

    #[test]
    fn speakers_without_the_vad_model_name_the_install_command() {
        let err = vad_mode_for_diarization(false).expect_err("diarization needs the VAD model");

        assert_eq!(crate::errors::code_of(&err), ErrorCode::ModelMissing);
        assert!(format!("{err}").contains("kesha install --vad"));
    }

    #[test]
    fn no_vad_with_speakers_is_invalid_before_any_model_is_resolved() {
        // #772: checked after diarize-model resolution, this reported E_MODEL_MISSING.
        let opts = TranscribeOptionsBuilder::new()
            .vad(VadMode::Off)
            .with_segments()
            .with_speakers()
            .build();

        let err = transcribe_with_options("/nonexistent/kesha-768.wav", &opts)
            .expect_err("--speakers --no-vad must be rejected as an invalid argument");

        assert_eq!(crate::errors::code_of(&err), ErrorCode::InvalidArg);
    }

    #[test]
    fn on_mode_always_uses_vad_regardless_of_other_inputs() {
        assert_eq!(decide(VadMode::On, None, false), VadDecision::Vad);
        assert_eq!(decide(VadMode::On, Some(5.0), false), VadDecision::Vad);
        assert_eq!(decide(VadMode::On, Some(300.0), true), VadDecision::Vad);
    }

    #[test]
    fn off_mode_always_uses_plain_regardless_of_other_inputs() {
        assert_eq!(decide(VadMode::Off, None, true), VadDecision::Plain);
        assert_eq!(decide(VadMode::Off, Some(3600.0), true), VadDecision::Plain);
    }

    #[test]
    fn auto_short_audio_uses_plain_with_no_hint() {
        assert_eq!(decide(VadMode::Auto, Some(30.0), true), VadDecision::Plain);
        assert_eq!(decide(VadMode::Auto, Some(119.9), true), VadDecision::Plain);
    }

    #[test]
    fn auto_long_audio_with_vad_installed_routes_through_vad() {
        assert_eq!(
            decide(VadMode::Auto, Some(AUTO_VAD_MIN_SECONDS), true),
            VadDecision::Vad
        );
        assert_eq!(decide(VadMode::Auto, Some(3600.0), true), VadDecision::Vad);
    }

    #[test]
    fn auto_long_audio_without_vad_prints_hint() {
        assert_eq!(
            decide(VadMode::Auto, Some(300.0), false),
            VadDecision::PlainWithHint
        );
    }

    #[test]
    fn auto_very_long_audio_without_vad_routes_to_chunked_fallback() {
        assert_eq!(
            decide(
                VadMode::Auto,
                Some(FULL_FILE_SINGLE_PASS_MAX_SECONDS),
                false
            ),
            VadDecision::ChunkedWithHint
        );
    }

    #[test]
    fn auto_unknown_duration_skips_trigger_silently() {
        // Unknown duration → treat as short, never surprise the user with VAD.
        assert_eq!(decide(VadMode::Auto, None, true), VadDecision::Plain);
        assert_eq!(decide(VadMode::Auto, None, false), VadDecision::Plain);
    }

    // ── word timings (#720) ──────────────────────────────────────────────────

    fn chunk_with_words(text: &str, words: &[(&str, f32, f32)]) -> TranscriptionChunk {
        TranscriptionChunk {
            text: text.to_string(),
            words: Some(
                words
                    .iter()
                    .map(|&(word, start, end)| WordTiming {
                        word: word.to_string(),
                        start,
                        end,
                    })
                    .collect(),
            ),
        }
    }

    fn word_spans(segment: &TranscriptionSegment) -> Vec<(&str, f32, f32)> {
        segment
            .words
            .as_ref()
            .expect("segment carries words")
            .iter()
            .map(|w| {
                let round = |v: f32| (v * 1000.0).round() / 1000.0;
                (w.word.as_str(), round(w.start), round(w.end))
            })
            .collect()
    }

    /// Backends time words against the slice they were handed, so each VAD span
    /// owes them its own start offset — otherwise every span reads from zero.
    #[test]
    fn vad_segments_put_words_on_the_file_clock() {
        let spans = vec![(0.5, 1.5), (2.0, 3.5)];
        let samples = vec![0.0_f32; 16_000 * 6];
        let segs = build_vad_output_segments(&spans, &samples, 16_000.0, |_| {
            Ok(chunk_with_words(
                "one two",
                &[("one", 0.0, 0.4), ("two", 0.4, 0.8)],
            ))
        });
        assert_eq!(
            word_spans(&segs[0]),
            vec![("one", 0.5, 0.9), ("two", 0.9, 1.3)]
        );
        assert_eq!(
            word_spans(&segs[1]),
            vec![("one", 2.0, 2.4), ("two", 2.4, 2.8)]
        );
    }

    /// The TDT duration head can predict past the end of the slice; a word
    /// reaching outside the segment carrying it would break every consumer that
    /// treats the segment as the bound.
    #[test]
    fn word_spans_stay_inside_their_segment() {
        let spans = vec![(0.5, 1.0)];
        let samples = vec![0.0_f32; 16_000 * 2];
        let segs = build_vad_output_segments(&spans, &samples, 16_000.0, |_| {
            Ok(chunk_with_words("late", &[("late", 0.4, 0.9)]))
        });
        assert_eq!(word_spans(&segs[0]), vec![("late", 0.9, 1.0)]);
    }

    /// The seam trim drops whole words off the front of a chunk's text; the
    /// timings must lose exactly the same ones or words and text disagree.
    #[test]
    fn chunked_segments_drop_words_in_step_with_the_trimmed_seam() {
        let samples = vec![0.0_f32; 30];
        let mut call = 0usize;
        let segs = build_chunked_output_segments(&samples, 10.0, 1.0, 0.2, |_slice| {
            call += 1;
            match call {
                1 => Ok(chunk_with_words(
                    "hello there over the wire",
                    &[
                        ("hello", 0.0, 0.2),
                        ("there", 0.2, 0.4),
                        ("over", 0.4, 0.6),
                        ("the", 0.6, 0.7),
                        ("wire", 0.7, 0.9),
                    ],
                )),
                _ => Ok(chunk_with_words(
                    "there over the wire world",
                    &[
                        ("there", 0.0, 0.2),
                        ("over", 0.2, 0.4),
                        ("the", 0.4, 0.5),
                        ("wire", 0.5, 0.7),
                        ("world", 0.7, 0.9),
                    ],
                )),
            }
        })
        .unwrap();

        assert_eq!(segs[1].text, "world");
        // Window 2 starts at sample 8 of 10/s audio, so its slice-local 0.7 s
        // is 1.5 s into the file.
        assert_eq!(word_spans(&segs[1]), vec![("world", 1.5, 1.7)]);
        for seg in &segs {
            assert_eq!(
                seg.words.as_ref().unwrap().len(),
                seg.text.split_whitespace().count(),
                "{seg:?}: words and text disagree"
            );
        }
    }

    /// CoreML cannot produce words today; `None` must survive the segmenting
    /// paths as absence rather than becoming an empty list (#720).
    #[test]
    fn segments_omit_words_when_the_backend_has_none() {
        let samples = vec![0.0_f32; 16_000 * 2];
        let segs = build_vad_output_segments(&[(0.0, 1.0)], &samples, 16_000.0, |_| {
            Ok("spoken".to_string().into())
        });
        assert!(segs[0].words.is_none());
        let json = serde_json::to_string(&segs[0]).unwrap();
        assert!(!json.contains("words"), "{json}");
    }

    #[test]
    fn transcription_segment_speaker_field_omits_when_none() {
        let s = TranscriptionSegment {
            start: 0.0,
            end: 1.0,
            text: "hi".into(),
            speaker: None,
            words: None,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(
            !json.contains("\"speaker\""),
            "speaker:None should be omitted, got {json}"
        );
    }

    #[test]
    fn transcribe_options_default_is_text_only_auto() {
        // Must match the legacy `transcribe(_, mode)` text-only path: Auto VAD, no segments, no speakers.
        let o = TranscribeOptions::default();
        assert_eq!(o.mode, VadMode::Auto);
        assert!(!o.with_segments);
        assert!(!o.with_speakers);
        assert!(!o.itn, "the ITN pass must never be on by default (#710)");
    }

    /// The VAD path returns its speech spans whether or not segments were
    /// requested, while plain returns none and chunked clears them. Text-only
    /// ITN must not depend on which path ran: normalizing per span rewrites a
    /// number phrase VAD split in two as "20 1" instead of "21" (#710).
    #[test]
    fn text_only_itn_is_whole_transcript_on_every_path() {
        let vad_shaped = TranscriptionOutput {
            text: "twenty one".into(),
            segments: vec![
                TranscriptionSegment {
                    start: 0.0,
                    end: 1.0,
                    text: "twenty".into(),
                    speaker: None,
                    words: None,
                },
                TranscriptionSegment {
                    start: 1.0,
                    end: 2.0,
                    text: "one".into(),
                    speaker: None,
                    words: None,
                },
            ],
        };
        let plain_shaped = TranscriptionOutput {
            text: "twenty one".into(),
            segments: vec![],
        };

        let from_vad = finalize_output(vad_shaped, false, true);
        let from_plain = finalize_output(plain_shaped, false, true);

        assert_eq!(from_vad.text, from_plain.text);
        assert_eq!(from_vad.text, "21");
        assert!(
            from_vad.segments.is_empty(),
            "with_segments=false must emit no segments regardless of path"
        );
    }

    /// The counterpart to the parity test: requesting segments keeps the
    /// per-segment contract, so `--json --timestamps` still round-trips.
    #[test]
    fn requested_segments_keep_per_segment_itn() {
        let out = finalize_output(
            TranscriptionOutput {
                text: "forty two".into(),
                segments: vec![TranscriptionSegment {
                    start: 0.0,
                    end: 1.0,
                    text: "forty two".into(),
                    speaker: Some(3),
                    words: None,
                }],
            },
            true,
            true,
        );

        assert_eq!(out.segments.len(), 1);
        assert_eq!(out.segments[0].text, "42");
        assert_eq!(out.segments[0].speaker, Some(3));
        assert_eq!(out.text, "42");
    }

    #[test]
    fn transcribe_with_options_rejects_speakers_without_segments() {
        // Greptile P1 on #290: `{with_speakers: true, with_segments: false}`
        // would silently drop every speaker label on the plain path. The
        // guard rejects the combination before any model lookup or audio
        // probe, so a bogus `audio_path` is fine — we never get there.
        let opts = TranscribeOptions {
            mode: VadMode::Off,
            with_segments: false,
            with_speakers: true,
            itn: false,
        };
        let err = transcribe_with_options("/dev/null", &opts)
            .expect_err("speakers-without-segments must error");
        let msg = format!("{err}");
        assert!(
            msg.contains("with_speakers requires with_segments"),
            "error message must explain the constraint, got: {msg}"
        );
    }

    #[cfg(all(feature = "system_diarize", target_os = "macos"))]
    #[test]
    fn transcribe_with_speakers_checks_diarize_model_before_asr_install() {
        let _env_lock = crate::util::test_env::lock();
        let cache = tempfile::tempdir().unwrap();
        let missing_diarize_model = cache.path().join("missing-diarize.mlpackage");
        let _cache_guard =
            crate::util::test_env::EnvGuard::set("KESHA_CACHE_DIR", cache.path().to_str().unwrap());
        let _diarize_guard = crate::util::test_env::EnvGuard::set(
            "KESHA_DIARIZE_MODEL_PATH",
            missing_diarize_model.to_str().unwrap(),
        );
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/tone-3s.wav")
            .to_string_lossy()
            .into_owned();
        let opts = TranscribeOptionsBuilder::new()
            .vad(VadMode::Auto)
            .with_segments()
            .with_speakers()
            .build();

        let err = transcribe_with_options(&fixture, &opts)
            .expect_err("missing diarization model must fail before ASR lookup");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("KESHA_DIARIZE_MODEL_PATH set but path does not exist"),
            "expected diarization model preflight error, got: {msg}"
        );
        assert!(
            !msg.contains("No transcription models installed"),
            "diarization preflight must happen before ASR install lookup, got: {msg}"
        );
    }

    // ── seam splice: one test per failure shape upstream FluidAudio hit ─────

    /// Budget for a 5 s overlap, matching the production chunker.
    fn budget() -> usize {
        seam_word_budget(FIXED_CHUNK_OVERLAP_SECONDS)
    }

    #[test]
    fn seam_splice_without_previous_text_returns_current_unchanged() {
        assert_eq!(
            trim_repeated_prefix("", "hello world again now", budget()),
            "hello world again now"
        );
    }

    #[test]
    fn seam_splice_drops_the_re_transcribed_overlap() {
        let prev = "we can merge it into the main branch";
        let curr = "merge it into the main branch and then deploy";
        assert_eq!(
            trim_repeated_prefix(prev, curr, budget()),
            "and then deploy"
        );
    }

    #[test]
    fn seam_splice_skips_a_mangled_overlap_head() {
        // The new window has no left context, so its first word is often
        // garbage ("engaging" for "staging"). The anchor has to be findable
        // past it, or the whole overlap lands in the transcript twice.
        let prev = "deploy to the staging environment and run the smoke tests";
        let curr = "engaging environment and run the smoke tests then verify";
        assert_eq!(trim_repeated_prefix(prev, curr, budget()), "then verify");
    }

    #[test]
    fn seam_splice_recovers_when_the_previous_window_ends_mid_word() {
        // Window edge cut "authentication" down to "author"; every anchor
        // ending in that fragment is unmatchable.
        let prev = "we should schedule a code review session for the new author";
        let curr = "schedule a code review session for the new authentication module next week";
        assert_eq!(
            trim_repeated_prefix(prev, curr, budget()),
            "authentication module next week"
        );
    }

    #[test]
    fn seam_splice_never_cuts_a_word_in_half() {
        // Byte-granular matching spliced "operational" onto "…the operation"
        // and emitted "al" — upstream FluidAudio #683/#688.
        let prev = "we discussed the operation";
        let curr = "operational costs went up sharply";
        assert_eq!(
            trim_repeated_prefix(prev, curr, budget()),
            "operational costs went up sharply"
        );
    }

    #[test]
    fn seam_splice_keeps_a_word_whose_spelling_ends_the_previous_chunk() {
        // "cooperation" ends with "operation"; a byte-granular match ate the
        // real word that followed — the DROP shape of upstream #759.
        let prev = "they praised the cooperation";
        let curr = "operation nightfall begins at dawn";
        assert_eq!(
            trim_repeated_prefix(prev, curr, budget()),
            "operation nightfall begins at dawn"
        );
    }

    #[test]
    fn seam_splice_ignores_an_anchor_shorter_than_the_minimum() {
        let prev = "the report is ready to send";
        let curr = "to send it out by five";
        assert_eq!(
            trim_repeated_prefix(prev, curr, budget()),
            "to send it out by five",
            "a {SEAM_MIN_ANCHOR_WORDS}-word floor keeps coincidental phrases from splicing"
        );
    }

    #[test]
    fn seam_splice_keeps_everything_when_nothing_anchors() {
        let prev = "the database migration completed successfully";
        let curr = "unrelated speech about something else entirely";
        assert_eq!(
            trim_repeated_prefix(prev, curr, budget()),
            "unrelated speech about something else entirely"
        );
    }

    #[test]
    fn seam_splice_folds_case_and_trailing_punctuation() {
        let prev = "run the smoke tests, then wait.";
        let curr = "Run the Smoke Tests, then wait! Results follow";
        assert_eq!(trim_repeated_prefix(prev, curr, budget()), "Results follow");
    }

    #[test]
    fn seam_splice_handles_multibyte_text() {
        let prev = "проверь все свои конфиги перед запуском";
        let curr = "все свои конфиги перед запуском и потом отпишись";
        assert_eq!(
            trim_repeated_prefix(prev, curr, budget()),
            "и потом отпишись"
        );
    }

    #[test]
    fn seam_splice_keeps_a_late_repeat_of_the_previous_tail() {
        // The speaker re-quotes an earlier phrase several words into the new
        // window. Anchoring on that recurrence would delete the clause in
        // between — real speech, not re-transcribed overlap.
        let prev = "we should probably just let's take that offline";
        let curr =
            "garbled audio before we continue I said let's take that offline but actually stay here";
        assert_eq!(trim_repeated_prefix(prev, curr, budget()), curr);
    }

    #[test]
    fn seam_splice_keeps_a_phrase_the_speaker_repeated_across_the_seam() {
        // Said twice on purpose: the overlap copy goes, the second one stays.
        let prev = "can you check the logs now please";
        let curr = "check the logs now please check the logs now please again";
        assert_eq!(
            trim_repeated_prefix(prev, curr, budget()),
            "check the logs now please again"
        );
    }

    #[test]
    fn seam_splice_will_not_truncate_a_repeated_word_run() {
        // A run of one repeated word carries no positional information: an
        // anchor inside it matches anywhere in it, so splicing would cut the
        // run at an arbitrary point.
        let prev = "ну да да да да да";
        let curr = "да да да да да да потом поехали дальше";
        assert_eq!(trim_repeated_prefix(prev, curr, budget()), curr);
    }

    #[test]
    fn seam_splice_retry_keeps_everything_when_the_shortened_anchor_sits_late() {
        // Previous window ends mid-word ("rev" for "review") and the phrase
        // before it recurs deep in the new chunk. Dropping the fragment must
        // not let the retry treat that recurrence as the overlap.
        let prev = "the release notes are ready for the final rev";
        let curr =
            "some other clause entirely the release notes are ready for the final review ship it";
        assert_eq!(trim_repeated_prefix(prev, curr, budget()), curr);
    }

    #[test]
    fn seam_splice_retry_needs_more_than_the_minimum_anchor() {
        // Dropping the truncated final word of a 4-word segment leaves too
        // little to anchor on, so the overlap is emitted twice rather than
        // spliced on a 3-word guess.
        let prev = "for the new author";
        let curr = "for the new authentication module ships today";
        assert_eq!(trim_repeated_prefix(prev, curr, budget()), curr);
    }

    #[test]
    fn seam_splice_will_not_reach_past_its_budget() {
        // A repeat this far into the new window belongs to later speech, not
        // to the overlap; splicing on it would delete everything before it.
        let prev = "the meeting has been rescheduled";
        let filler = "one two three four five six seven eight nine ten ".repeat(4);
        let curr = format!("{filler}{prev} tail");
        let out = trim_repeated_prefix(prev, &curr, seam_word_budget(1.0));
        assert_eq!(out, curr, "budget must bound how much can be discarded");
    }

    // ── fixed_chunk_windows guard tests ─────────────────────────────────────

    #[test]
    fn fixed_chunk_windows_total_zero_returns_empty() {
        assert!(fixed_chunk_windows(
            0,
            16_000.0,
            FIXED_CHUNK_SECONDS,
            FIXED_CHUNK_OVERLAP_SECONDS
        )
        .is_empty());
    }

    #[test]
    fn fixed_chunk_windows_sr_zero_returns_empty() {
        assert!(fixed_chunk_windows(
            16_000,
            0.0,
            FIXED_CHUNK_SECONDS,
            FIXED_CHUNK_OVERLAP_SECONDS
        )
        .is_empty());
    }

    #[test]
    fn fixed_chunk_windows_chunk_zero_returns_empty() {
        assert!(fixed_chunk_windows(16_000, 16_000.0, 0.0, FIXED_CHUNK_OVERLAP_SECONDS).is_empty());
    }

    #[test]
    fn fixed_chunk_windows_overlap_ge_chunk_clamped_no_infinite_loop() {
        // overlap ≥ chunk → step clamped to 1; must terminate and cover all samples.
        let windows = fixed_chunk_windows(100, 10.0, 1.0, 5.0);
        assert!(!windows.is_empty(), "should produce at least one window");
        // last window must reach the end
        assert_eq!(windows.last().unwrap().input_end, 100);
    }

    #[test]
    fn fixed_chunk_windows_tile_the_audio_exactly_once() {
        // Upstream FluidAudio #747/#800 (final window truncated) and #761
        // (seam-gap content drop) are both "some audio reaches no window".
        // Output ranges must abut with no gap, no overlap, and reach the end.
        for total in [1usize, 999, 16_000, 160_001, 1_234_567] {
            for (chunk, overlap) in [(1.0_f32, 0.2_f32), (10.0, 5.0), (600.0, 5.0), (0.5, 0.49)] {
                let ctx = format!("total={total} chunk={chunk} overlap={overlap}");
                let windows = fixed_chunk_windows(total, 16_000.0, chunk, overlap);
                assert!(!windows.is_empty(), "{ctx}: no windows");
                assert_eq!(windows[0].output_start_s, 0.0, "{ctx}: gap at the start");
                assert_eq!(
                    windows.last().unwrap().input_end,
                    total,
                    "{ctx}: final window stops short of the audio"
                );
                for w in &windows {
                    assert!(w.input_start < w.input_end, "{ctx}: empty input {w:?}");
                    assert!(
                        w.output_end_s > w.output_start_s,
                        "{ctx}: empty output {w:?}"
                    );
                    assert!(
                        w.input_start as f32 / 16_000.0 <= w.output_start_s,
                        "{ctx}: {w:?}"
                    );
                }
                for pair in windows.windows(2) {
                    assert_eq!(
                        pair[0].output_end_s, pair[1].output_start_s,
                        "{ctx}: output ranges must abut, got {pair:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn chunked_segments_stay_ordered_across_seams() {
        // Upstream FluidAudio #825/#830 reordered tokens at a seam. Kesha's
        // merge appends windows in time order, so this locks that in.
        let samples = vec![0.0_f32; 16_000 * 40];
        let mut call = 0usize;
        let segs = build_chunked_output_segments(&samples, 16_000.0, 10.0, 5.0, |_slice| {
            call += 1;
            Ok(format!("alpha{call} beta{call} gamma{call} delta{call}").into())
        })
        .unwrap();
        assert!(
            segs.len() >= 4,
            "expected several windows, got {}",
            segs.len()
        );
        for pair in segs.windows(2) {
            assert!(pair[1].start >= pair[0].start, "out of order: {pair:?}");
            assert_eq!(pair[0].end, pair[1].start, "gap between {pair:?}");
        }
        let joined = join_segment_texts(&segs);
        let order: Vec<usize> = (1..=segs.len())
            .filter_map(|i| joined.find(&format!("alpha{i} ")))
            .collect();
        assert_eq!(order.len(), segs.len(), "a window went missing: {joined}");
        assert!(order.windows(2).all(|p| p[0] < p[1]), "reordered: {joined}");
    }

    #[test]
    fn fixed_chunk_windows_single_chunk_when_total_le_chunk_samples() {
        // 5 samples, chunk = 1.0 s × 10 Hz = 10 samples → only one window needed.
        let windows = fixed_chunk_windows(5, 10.0, 1.0, 0.0);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].input_start, 0);
        assert_eq!(windows[0].input_end, 5);
    }

    // ── validate_plain_transcribe_safety exact boundary test ─────────────────

    #[test]
    fn validate_plain_transcribe_safety_exact_boundary_off() {
        // At exactly FULL_FILE_SINGLE_PASS_MAX_SECONDS with VadMode::Off, must reject.
        let err = validate_plain_transcribe_safety(
            VadMode::Off,
            Some(FULL_FILE_SINGLE_PASS_MAX_SECONDS),
            false,
        )
        .expect_err("exact boundary must be rejected");
        assert!(err.to_string().contains("refusing --no-vad"), "{err}");
    }

    // ── TranscriptionOutput JSON round-trip ──────────────────────────────────

    #[test]
    fn transcription_output_json_round_trip() {
        let original = TranscriptionOutput {
            text: "hello world".to_string(),
            segments: vec![TranscriptionSegment {
                start: 0.0,
                end: 1.5,
                text: "hello world".to_string(),
                speaker: Some(1),
                words: None,
            }],
        };
        let json = serde_json::to_string(&original).expect("serialise");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(parsed["text"], "hello world");
        assert_eq!(parsed["segments"][0]["start"], 0.0);
        assert_eq!(parsed["segments"][0]["end"], 1.5);
        assert_eq!(parsed["segments"][0]["speaker"], 1);
    }

    // ── join_segment_texts ───────────────────────────────────────────────────

    #[test]
    fn join_segment_texts_empty_slice() {
        assert_eq!(join_segment_texts(&[]), "");
    }

    #[test]
    fn join_segment_texts_joins_with_space() {
        let segs = vec![
            TranscriptionSegment {
                start: 0.0,
                end: 1.0,
                text: "foo".to_string(),
                speaker: None,
                words: None,
            },
            TranscriptionSegment {
                start: 1.0,
                end: 2.0,
                text: "bar".to_string(),
                speaker: None,
                words: None,
            },
        ];
        assert_eq!(join_segment_texts(&segs), "foo bar");
    }
}

/// Long-form seam audit against real speech (#722). Kesha's overlapped
/// windowing and merge are its own code, never inherited from upstream
/// FluidAudio, so they never inherited upstream's seam fixes either. These
/// run the chunk-and-merge path against a single full-file pass over the
/// same audio and diff the seams.
///
/// Skips — without failing — when the Parakeet weights aren't installed,
/// matching the cache-gated convention in `rust/tests/common/mod.rs`.
#[cfg(test)]
mod seam_long_form {
    use super::*;

    const SR: f32 = 16_000.0;
    const OVERLAP_S: f32 = FIXED_CHUNK_OVERLAP_SECONDS;

    /// Eight unrelated English utterances. Concatenated they run ~36 s, so a
    /// chunk length in the teens puts a seam inside a sentence — and, at some
    /// lengths, inside a word.
    const FIXTURES: &[&str] = &[
        "01-check-email.ogg",
        "02-meeting-rescheduled.ogg",
        "03-review-pull-request.ogg",
        "04-deploy-staging.ogg",
        "05-database-migration.ogg",
        "06-code-review-session.ogg",
        "07-run-test-suite.ogg",
        "08-update-documentation.ogg",
    ];

    fn backend_or_skip() -> Option<Box<dyn backend::TranscribeBackend>> {
        if !models::is_cached(models::ModelKind::Asr) {
            eprintln!("SKIP seam_long_form: ASR weights not installed (`kesha install`)");
            return None;
        }
        let dir = models::model_dir(models::ModelKind::Asr)
            .to_string_lossy()
            .into_owned();
        Some(backend::create_backend(&dir).expect("create ASR backend"))
    }

    fn fixture(name: &str) -> Vec<f32> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/benchmark-en")
            .join(name);
        audio::load_audio(path.to_str().unwrap()).unwrap_or_else(|e| {
            panic!("load {name}: {e} — run `git lfs pull` if fixtures are pointer stubs")
        })
    }

    fn keys(text: &str) -> Vec<String> {
        seam_words(text).into_iter().map(|w| w.key).collect()
    }

    /// Fraction of `reference` words recoverable from `actual` in order.
    fn recall(reference: &[String], actual: &[String]) -> f32 {
        if reference.is_empty() {
            return 1.0;
        }
        let mut cursor = 0usize;
        let mut hits = 0usize;
        for want in reference {
            if let Some(at) = actual[cursor..].iter().position(|w| w == want) {
                cursor += at + 1;
                hits += 1;
            }
        }
        hits as f32 / reference.len() as f32
    }

    /// The first word run of length `n` present in both slices, if any.
    fn shared_run(a: &[String], b: &[String], n: usize) -> Option<String> {
        if a.len() < n || b.len() < n {
            return None;
        }
        a.windows(n)
            .find(|run| b.windows(n).any(|other| other == *run))
            .map(|run| run.join(" "))
    }

    /// The whole point of the overlap is that both windows hear it; exactly one
    /// of them may print it. A word run repeated across the seam is the
    /// duplicate shape upstream FluidAudio chased through #708/#825/#830.
    fn assert_no_duplicated_seam(segments: &[TranscriptionSegment], ctx: &str) {
        let budget = seam_word_budget(OVERLAP_S);
        for pair in segments.windows(2) {
            let left = keys(&pair[0].text);
            let right = keys(&pair[1].text);
            let tail = &left[left.len().saturating_sub(budget)..];
            let head = &right[..budget.min(right.len())];
            if let Some(run) = shared_run(tail, head, SEAM_MIN_ANCHOR_WORDS) {
                panic!(
                    "{ctx}: seam at {:.2}s emits \"{run}\" twice\n  left tail:  {}\n  right head: {}",
                    pair[1].start,
                    tail.join(" "),
                    head.join(" "),
                );
            }
        }
    }

    fn audit(
        be: &mut Box<dyn backend::TranscribeBackend>,
        samples: &[f32],
        reference: &[String],
        single: &[String],
        chunk_s: f32,
        ctx: &str,
    ) {
        let segments = build_chunked_output_segments(samples, SR, chunk_s, OVERLAP_S, |slice| {
            be.transcribe_samples(slice)
        })
        .unwrap_or_else(|e| panic!("{ctx}: chunked transcription failed: {e}"));
        assert!(
            segments.len() >= 2,
            "{ctx}: needs at least one seam, got {} segment(s)",
            segments.len()
        );

        for pair in segments.windows(2) {
            assert_eq!(
                pair[0].end, pair[1].start,
                "{ctx}: timestamp gap between {pair:?}"
            );
        }

        assert_no_duplicated_seam(&segments, ctx);

        let merged = keys(&join_segment_texts(&segments));
        let r = recall(reference, &merged);
        assert!(
            r >= 0.9,
            "{ctx}: merge dropped speech — reference recall {r:.2}\n  reference: {}\n  merged:    {}",
            reference.join(" "),
            merged.join(" "),
        );
        let inflation = merged.len() as f32 / single.len() as f32;
        eprintln!("{ctx}: recall {r:.3} inflation {inflation:.3}");
        // Measured 1.00-1.09 across these fixtures; the bug this locks out
        // inflated real transcripts 1.11-1.57x (#722).
        assert!(
            inflation <= 1.15,
            "{ctx}: merged transcript is {inflation:.2}x the single-pass one \
             ({} vs {} words)\n  merged: {}",
            merged.len(),
            single.len(),
            merged.join(" "),
        );
    }

    #[test]
    fn chunked_merge_of_long_form_speech_matches_a_single_pass() {
        let Some(mut be) = backend_or_skip() else {
            return;
        };

        let mut samples: Vec<f32> = Vec::new();
        let mut reference: Vec<String> = Vec::new();
        for name in FIXTURES {
            let utterance = fixture(name);
            reference.extend(keys(&be.transcribe_samples(&utterance).unwrap().text));
            samples.extend_from_slice(&utterance);
        }
        let single = keys(&be.transcribe_samples(&samples).unwrap().text);
        eprintln!(
            "seam audit: {:.1}s of speech, {} reference words, {} single-pass words",
            samples.len() as f32 / SR,
            reference.len(),
            single.len()
        );

        // Three seam placements: mid-sentence, and two that cut the previous
        // window off mid-word ("…the AP" for "API", "…the new author" for
        // "authentication"). Production chunks at 600 s; the teens are the
        // adversarial end of the same code path.
        for chunk_s in [15.5_f32, 20.0, 25.0] {
            audit(
                &mut be,
                &samples,
                &reference,
                &single,
                chunk_s,
                &format!("chunk={chunk_s}s"),
            );
        }
    }

    #[test]
    fn chunked_merge_survives_silence_between_utterances() {
        let Some(mut be) = backend_or_skip() else {
            return;
        };

        let gap = vec![0.0_f32; (3.0 * SR) as usize];
        let mut samples: Vec<f32> = Vec::new();
        let mut reference: Vec<String> = Vec::new();
        for name in FIXTURES {
            let utterance = fixture(name);
            reference.extend(keys(&be.transcribe_samples(&utterance).unwrap().text));
            samples.extend_from_slice(&utterance);
            samples.extend_from_slice(&gap);
        }
        let single = keys(&be.transcribe_samples(&samples).unwrap().text);

        audit(
            &mut be,
            &samples,
            &reference,
            &single,
            20.0,
            "silence-padded chunk=20s",
        );
    }
}
