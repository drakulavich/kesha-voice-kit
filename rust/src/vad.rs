//! Silero VAD v5 ONNX wrapper — turns a 16 kHz mono f32 waveform into
//! `(start_s, end_s)` speech segments.
//!
//! Model I/O (confirmed by spike against `silero_vad.onnx` opset 16):
//!   input   f32 [1, N]       — audio samples (N=512 for 16 kHz v5)
//!   state   f32 [2, 1, 128]  — LSTM state, init zeros, carry across frames
//!   sr      int64 scalar     — 16000
//!   output  f32 [1, 1]       — speech probability
//!   stateN  f32 [2, 1, 128]  — next LSTM state
//!
//! Post-processing is the standard Silero pipeline: per-frame thresholding,
//! merge across `min_silence`, require `min_speech`, pad both edges by
//! `speech_pad`. Tuned at defaults adapted from upstream's Python reference.

use anyhow::{Context, Result};
use ndarray::{arr0, Array2, Array3};
use ort::session::Session;
use ort::value::Value;
use std::path::Path;

pub const SAMPLE_RATE: u32 = 16_000;
/// 32 ms @ 16 kHz — Silero v5's mandated hop for 16 kHz audio.
const FRAME_SAMPLES: usize = 512;
/// v5 requires a 64-sample rolling context prepended to each 512-sample
/// frame — the ONNX input is therefore length 576, even though the API
/// nominally "takes 512 samples at 16 kHz". Missing this makes the model
/// output ~0 for everything (matches upstream's Python `OnnxWrapper`).
const CONTEXT_SAMPLES: usize = 64;
const INPUT_SAMPLES: usize = CONTEXT_SAMPLES + FRAME_SAMPLES;
const STATE_LEN: usize = 2 * 128;

#[derive(Debug, Clone, Copy)]
pub struct VadConfig {
    /// Per-frame speech probability threshold (0.0–1.0). Lower = more
    /// permissive. Upstream default is 0.5.
    pub threshold: f32,
    /// Drop candidate speech runs shorter than this.
    pub min_speech_ms: u32,
    /// Merge silences shorter than this into the surrounding speech.
    pub min_silence_ms: u32,
    /// Pad each segment on both sides by this many ms.
    pub speech_pad_ms: u32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            threshold: 0.5,
            min_speech_ms: 250,
            min_silence_ms: 100,
            speech_pad_ms: 30,
        }
    }
}

/// Configuration for live end-of-utterance detection.
#[derive(Debug, Clone, Copy)]
pub struct EndpointConfig {
    pub threshold: f32,
    pub trailing_silence_ms: u32,
    pub min_speech_ms: u32,
}

impl Default for EndpointConfig {
    fn default() -> Self {
        Self {
            threshold: 0.5,
            trailing_silence_ms: 1_000,
            min_speech_ms: 250,
        }
    }
}

/// Turns Silero frame probabilities into a one-way stop decision.
pub struct VadEndpoint {
    cfg: EndpointConfig,
    speech_samples: usize,
    trailing_silence_samples: usize,
}

/// Stateful Silero inference for live audio. Audio may arrive in arbitrary
/// chunks; only complete 512-sample hops are evaluated and the tail remains
/// buffered for the next call.
pub struct StreamingVad {
    detector: VadDetector,
    endpoint: VadEndpoint,
    state: Vec<f32>,
    input_buf: Vec<f32>,
    pending: Vec<f32>,
}

impl VadEndpoint {
    pub fn new(cfg: EndpointConfig) -> Self {
        Self {
            cfg,
            speech_samples: 0,
            trailing_silence_samples: 0,
        }
    }

    /// Returns true once an utterance of the configured minimum speech length
    /// is followed by the configured trailing silence.
    pub fn observe(&mut self, probability: f32) -> bool {
        if probability >= self.cfg.threshold {
            self.speech_samples += FRAME_SAMPLES;
            self.trailing_silence_samples = 0;
            return false;
        }

        if self.speech_samples < ms_to_samples_ceil(self.cfg.min_speech_ms, SAMPLE_RATE) {
            return false;
        }

        self.trailing_silence_samples += FRAME_SAMPLES;
        self.trailing_silence_samples
            >= ms_to_samples_ceil(self.cfg.trailing_silence_ms, SAMPLE_RATE)
    }
}

pub struct VadDetector {
    session: Session,
}

impl VadDetector {
    pub fn load(model_path: &Path) -> Result<Self> {
        // #990: decoder LSTM rejects >1 frame/call, so intra_threads(1) — 15.4% faster, bit-identical — is the only lever that pays.
        let session = Session::builder()
            .context("failed to create VAD session builder")?
            .with_intra_threads(1)
            .map_err(|e| anyhow::anyhow!("failed to configure VAD session threading: {e}"))?
            .commit_from_file(model_path)
            .with_context(|| {
                format!(
                    "failed to load Silero VAD from {} — run `kesha install --vad` first",
                    model_path.display()
                )
            })?;
        Ok(Self { session })
    }

    /// Detect speech segments in a 16 kHz mono f32 waveform.
    /// Returns `Vec<(start_s, end_s)>` in ascending order. Empty audio
    /// yields an empty vec without erroring.
    pub fn detect_segments(&mut self, audio: &[f32], cfg: VadConfig) -> Result<Vec<(f32, f32)>> {
        if audio.is_empty() {
            return Ok(vec![]);
        }
        let probs = self.frame_probs(audio)?;
        Ok(post_process(&probs, audio.len(), cfg, SAMPLE_RATE))
    }

    fn frame_probs(&mut self, audio: &[f32]) -> Result<Vec<f32>> {
        // Rolling 64-sample context starts as zeros and is updated to the
        // last 64 samples of each processed chunk (matches upstream's
        // `OnnxWrapper.__call__` in silero_vad/utils_vad.py).
        let mut state = vec![0.0_f32; STATE_LEN];
        let mut input_buf = vec![0.0_f32; INPUT_SAMPLES];
        let mut probs: Vec<f32> = Vec::with_capacity(audio.len().div_ceil(FRAME_SAMPLES));

        for chunk in audio.chunks(FRAME_SAMPLES) {
            let tail_start = INPUT_SAMPLES - CONTEXT_SAMPLES;
            input_buf.copy_within(tail_start..INPUT_SAMPLES, 0);
            let dst = &mut input_buf[CONTEXT_SAMPLES..];
            dst[..chunk.len()].copy_from_slice(chunk);
            if chunk.len() < FRAME_SAMPLES {
                dst[chunk.len()..].fill(0.0);
            }

            probs.push(self.frame_probability(&input_buf, &mut state)?);
        }

        Ok(probs)
    }

    fn frame_probability(&mut self, input_buf: &[f32], state: &mut [f32]) -> Result<f32> {
        // #990 spike: borrowed TensorRef measured 0% gain over these owned-Vec clones — kept simple.
        let input = Value::from_array(Array2::<f32>::from_shape_vec(
            (1, INPUT_SAMPLES),
            input_buf.to_vec(),
        )?)?;
        let state_val =
            Value::from_array(Array3::<f32>::from_shape_vec((2, 1, 128), state.to_vec())?)?;
        // `sr` is an ONNX scalar (rank 0) — `arr0` builds an Array0 which
        // serialises to a scalar tensor; passing rank-1 here would trip the
        // model into a silent shape mismatch on some ort builds.
        let sr_val = Value::from_array(arr0(SAMPLE_RATE as i64))?;

        let outputs = self.session.run(ort::inputs![
            "input" => input,
            "state" => state_val,
            "sr"    => sr_val,
        ])?;

        let (_prob_shape, prob_data) = outputs["output"].try_extract_tensor::<f32>()?;
        let (_state_shape, state_data) = outputs["stateN"].try_extract_tensor::<f32>()?;
        // In-place copy reuses the state Vec; previously `state = .to_vec()`
        // freed and reallocated ~1 KB every 32 ms.
        state.copy_from_slice(state_data);
        Ok(prob_data[0])
    }
}

impl StreamingVad {
    pub fn load(model_path: &Path, cfg: EndpointConfig) -> Result<Self> {
        Ok(Self {
            detector: VadDetector::load(model_path)?,
            endpoint: VadEndpoint::new(cfg),
            state: vec![0.0; STATE_LEN],
            input_buf: vec![0.0; INPUT_SAMPLES],
            pending: Vec::new(),
        })
    }

    /// Returns true when the accumulated speech has ended. Input must be 16 kHz
    /// mono f32 samples, matching [`SAMPLE_RATE`].
    pub fn feed(&mut self, samples: &[f32]) -> Result<bool> {
        self.pending.extend_from_slice(samples);
        let complete_samples = (self.pending.len() / FRAME_SAMPLES) * FRAME_SAMPLES;
        for chunk in self.pending[..complete_samples].chunks_exact(FRAME_SAMPLES) {
            let tail_start = INPUT_SAMPLES - CONTEXT_SAMPLES;
            self.input_buf.copy_within(tail_start..INPUT_SAMPLES, 0);
            self.input_buf[CONTEXT_SAMPLES..].copy_from_slice(chunk);
            let probability = self
                .detector
                .frame_probability(&self.input_buf, &mut self.state)?;
            if self.endpoint.observe(probability) {
                self.pending.drain(..complete_samples);
                return Ok(true);
            }
        }
        self.pending.drain(..complete_samples);
        Ok(false)
    }
}

/// Frame probs → smoothed speech segments. Pure function, no ONNX.
fn post_process(
    probs: &[f32],
    total_samples: usize,
    cfg: VadConfig,
    sample_rate: u32,
) -> Vec<(f32, f32)> {
    if probs.is_empty() || total_samples == 0 {
        return vec![];
    }

    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut in_speech = false;
    let mut span_start = 0usize;
    for (i, &p) in probs.iter().enumerate() {
        let start = i * FRAME_SAMPLES;
        let end = (start + FRAME_SAMPLES).min(total_samples);
        let is_speech = p >= cfg.threshold;
        if is_speech && !in_speech {
            span_start = start;
            in_speech = true;
        } else if !is_speech && in_speech {
            spans.push((span_start, start));
            in_speech = false;
        }
        // Guard: if we're still in speech at EOF, close on the last frame's end.
        if in_speech && i == probs.len() - 1 {
            spans.push((span_start, end));
            in_speech = false;
        }
    }
    if spans.is_empty() {
        return vec![];
    }

    // Merge spans separated by < min_silence in sample space to avoid rounding drift.
    let min_silence = ms_to_samples(cfg.min_silence_ms, sample_rate);
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(spans.len());
    for (s, e) in spans {
        match merged.last_mut() {
            Some(last) if s.saturating_sub(last.1) < min_silence => last.1 = e,
            _ => merged.push((s, e)),
        }
    }

    let min_speech = ms_to_samples(cfg.min_speech_ms, sample_rate);
    merged.retain(|(s, e)| e.saturating_sub(*s) >= min_speech);

    let pad = ms_to_samples(cfg.speech_pad_ms, sample_rate);
    let sr = sample_rate as f32;
    merged
        .into_iter()
        .map(|(s, e)| {
            let s = s.saturating_sub(pad);
            let e = (e + pad).min(total_samples);
            (s as f32 / sr, e as f32 / sr)
        })
        .collect()
}

fn ms_to_samples(ms: u32, sample_rate: u32) -> usize {
    ((ms as u64 * sample_rate as u64) / 1000) as usize
}

fn ms_to_samples_ceil(ms: u32, sample_rate: u32) -> usize {
    (ms as u64 * sample_rate as u64).div_ceil(1000) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> VadConfig {
        VadConfig::default()
    }

    /// Build a `probs` vector of the given frame count, marking specific
    /// ranges as speech (>= threshold).
    fn probs_with_speech(n_frames: usize, speech_ranges: &[(usize, usize)]) -> Vec<f32> {
        let mut probs = vec![0.0_f32; n_frames];
        for &(a, b) in speech_ranges {
            let hi = b.min(n_frames);
            if a < hi {
                probs[a..hi].fill(0.9);
            }
        }
        probs
    }

    #[test]
    fn empty_probs_returns_empty_segments() {
        assert!(post_process(&[], 0, cfg(), SAMPLE_RATE).is_empty());
    }

    #[test]
    fn all_silence_returns_no_segments() {
        let probs = vec![0.0_f32; 100];
        let segs = post_process(&probs, 100 * FRAME_SAMPLES, cfg(), SAMPLE_RATE);
        assert!(segs.is_empty(), "expected no segments, got {segs:?}");
    }

    #[test]
    fn all_speech_returns_single_segment_spanning_input() {
        // 100 frames @ 512 samples = 3.2 s of "speech"
        let probs = vec![0.9_f32; 100];
        let total = 100 * FRAME_SAMPLES;
        let segs = post_process(&probs, total, cfg(), SAMPLE_RATE);
        assert_eq!(segs.len(), 1);
        let (s, e) = segs[0];
        assert!(s <= 0.001, "start should be ~0s, got {s}");
        let total_s = total as f32 / SAMPLE_RATE as f32;
        assert!((e - total_s).abs() < 0.01, "end {e} should ~ {total_s}");
    }

    #[test]
    fn short_speech_below_min_speech_is_dropped() {
        // 3 speech frames = ~96 ms, below the 250 ms min_speech floor.
        let probs = probs_with_speech(50, &[(10, 13)]);
        let segs = post_process(&probs, 50 * FRAME_SAMPLES, cfg(), SAMPLE_RATE);
        assert!(segs.is_empty(), "expected drop, got {segs:?}");
    }

    #[test]
    fn nearby_speech_runs_are_merged_across_short_silence() {
        // Two 10-frame speech chunks separated by 2 silent frames (~64 ms,
        // below 100 ms min_silence). After merge, one segment only.
        let probs = probs_with_speech(60, &[(5, 15), (17, 27)]);
        let segs = post_process(&probs, 60 * FRAME_SAMPLES, cfg(), SAMPLE_RATE);
        assert_eq!(segs.len(), 1, "expected merge, got {segs:?}");
    }

    #[test]
    fn distant_speech_runs_stay_separate() {
        // Two 15-frame speech chunks separated by 10 silent frames (~320 ms,
        // well above min_silence). Each chunk is ~480 ms, above min_speech.
        let probs = probs_with_speech(80, &[(5, 20), (30, 45)]);
        let segs = post_process(&probs, 80 * FRAME_SAMPLES, cfg(), SAMPLE_RATE);
        assert_eq!(segs.len(), 2, "expected two segments, got {segs:?}");
    }

    #[test]
    fn speech_pad_does_not_exceed_audio_bounds() {
        // Speech up to the very last frame — padding would otherwise push
        // `end` past the audio length.
        let n = 30;
        let total = n * FRAME_SAMPLES;
        let probs = probs_with_speech(n, &[(0, n)]);
        let segs = post_process(&probs, total, cfg(), SAMPLE_RATE);
        assert_eq!(segs.len(), 1);
        let (_, e) = segs[0];
        let total_s = total as f32 / SAMPLE_RATE as f32;
        assert!(e <= total_s + 1e-6, "end {e} exceeds audio len {total_s}");
    }

    #[test]
    fn custom_threshold_flips_decision() {
        // All frames at p=0.3 — below default 0.5 (no speech), but above
        // a 0.2 custom threshold (whole file = speech).
        let probs = vec![0.3_f32; 50];
        let total = 50 * FRAME_SAMPLES;
        let strict = post_process(&probs, total, cfg(), SAMPLE_RATE);
        assert!(strict.is_empty());
        let lax = post_process(
            &probs,
            total,
            VadConfig {
                threshold: 0.2,
                ..cfg()
            },
            SAMPLE_RATE,
        );
        assert_eq!(lax.len(), 1);
    }

    #[test]
    fn ms_to_samples_rounds_down_consistently() {
        assert_eq!(ms_to_samples(1000, 16_000), 16_000);
        assert_eq!(ms_to_samples(500, 16_000), 8_000);
        assert_eq!(ms_to_samples(100, 16_000), 1_600);
        // 31 ms @ 16 kHz = 496 samples — just under one 512-frame window.
        assert_eq!(ms_to_samples(31, 16_000), 496);
    }

    #[test]
    fn endpoint_waits_for_the_configured_trailing_silence() {
        let mut endpoint = VadEndpoint::new(EndpointConfig {
            threshold: 0.5,
            trailing_silence_ms: 320,
            min_speech_ms: 192,
        });

        for _ in 0..6 {
            assert!(!endpoint.observe(0.9));
        }
        for _ in 0..9 {
            assert!(!endpoint.observe(0.1));
        }
        assert!(endpoint.observe(0.1));
    }

    #[test]
    fn endpoint_ignores_a_cough_and_a_short_mid_sentence_pause() {
        let mut endpoint = VadEndpoint::new(EndpointConfig {
            threshold: 0.5,
            trailing_silence_ms: 320,
            min_speech_ms: 192,
        });

        for _ in 0..2 {
            assert!(!endpoint.observe(0.9));
        }
        for _ in 0..20 {
            assert!(!endpoint.observe(0.1));
        }

        for _ in 0..6 {
            assert!(!endpoint.observe(0.9));
        }
        for _ in 0..9 {
            assert!(!endpoint.observe(0.1));
        }
        assert!(!endpoint.observe(0.9));
        for _ in 0..9 {
            assert!(!endpoint.observe(0.1));
        }
        assert!(endpoint.observe(0.1));
    }

    /// Exercises the incremental ONNX path with committed spoken audio. The
    /// fixture stays below the one-second endpoint window; only the committed
    /// trailing-silence fixture ends the take.
    #[test]
    fn streaming_endpoint_waits_for_a_trailing_pause_after_a_spoken_fixture() {
        let Some(path) = std::env::var_os("VAD_MODEL") else {
            eprintln!("VAD_MODEL not set; skipping");
            return;
        };
        let fixture = format!(
            "{}/../tests/fixtures/benchmark-en/03-review-pull-request.ogg",
            env!("CARGO_MANIFEST_DIR")
        );
        let mut samples = crate::audio::load_audio(Path::new(&fixture)).expect("decode fixture");
        let mut endpoint = StreamingVad::load(
            Path::new(&path),
            EndpointConfig {
                threshold: 0.5,
                trailing_silence_ms: 1_000,
                min_speech_ms: 250,
            },
        )
        .expect("load VAD");

        for chunk in samples.chunks(317) {
            assert!(
                !endpoint.feed(chunk).expect("score fixture"),
                "the endpoint fired before the trailing pause"
            );
        }

        let silence = crate::audio::load_audio(Path::new(&format!(
            "{}/../tests/fixtures/silence.wav",
            env!("CARGO_MANIFEST_DIR")
        )))
        .expect("decode silence fixture");
        for _ in 0..3 {
            samples.extend_from_slice(&silence);
        }
        let stopped = samples
            .chunks(317)
            .any(|chunk| endpoint.feed(chunk).expect("score trailing pause"));
        assert!(
            stopped,
            "the endpoint did not fire on one second of silence"
        );
    }

    /// Gated on VAD_MODEL — confirms wiring against the real ONNX when
    /// the file is present. Default CI doesn't download it so this is skipped.
    #[test]
    fn real_model_produces_probabilities_when_available() {
        let Some(path) = std::env::var_os("VAD_MODEL") else {
            eprintln!("VAD_MODEL not set; skipping");
            return;
        };
        let mut vad = VadDetector::load(Path::new(&path)).unwrap();
        // 2 s of synthetic "silence + pulse + silence" — not a content
        // check, just tensor wiring.
        let mut audio = vec![0.0_f32; 32_000];
        for (i, s) in audio.iter_mut().enumerate().take(24_000).skip(8_000) {
            *s = ((i as f32) * 0.05).sin() * 0.3;
        }
        let probs = vad.frame_probs(&audio).unwrap();
        assert!(probs.len() > 50, "probs too short: {}", probs.len());
        assert!(
            probs.iter().all(|&p| (0.0..=1.0).contains(&p)),
            "probs out of [0,1] range"
        );
    }

    /// #990: proves the tuned session above is bit-identical to the untuned default over the
    /// benchmark corpus plus a synthetic ~129s composite, and reports the numbers the ticket
    /// asks for. Gated like the tests above; `just vad-bench` runs it with printed output.
    #[test]
    fn tuned_session_matches_default_and_reports_990_measurement() {
        let Some(path) = std::env::var_os("VAD_MODEL") else {
            eprintln!("VAD_MODEL not set; skipping");
            return;
        };
        let path = Path::new(&path);

        let default_session = Session::builder()
            .expect("session builder")
            .commit_from_file(path)
            .expect("load VAD (untuned default)");
        let mut baseline = VadDetector {
            session: default_session,
        };
        let mut tuned = VadDetector::load(path).expect("load VAD (tuned)");

        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repo root");
        let mut fixtures: Vec<(String, Vec<f32>)> = Vec::new();
        for dir in ["tests/fixtures/benchmark", "tests/fixtures/benchmark-en"] {
            let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
                continue;
            };
            let mut paths: Vec<_> = entries
                .map(|e| e.expect("dir entry").path())
                .filter(|p| p.extension().is_some_and(|e| e == "ogg"))
                .collect();
            paths.sort();
            for p in paths {
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                let audio =
                    crate::audio::load_audio(&p).unwrap_or_else(|e| panic!("decode {name}: {e}"));
                fixtures.push((name, audio));
            }
        }
        if fixtures.is_empty() {
            eprintln!("no benchmark fixtures found — run `git lfs pull`; skipping");
            return;
        }

        let mut composite: Vec<f32> = Vec::new();
        while (composite.len() as f32 / SAMPLE_RATE as f32) < 129.0 {
            for (_, audio) in &fixtures {
                composite.extend_from_slice(audio);
            }
        }
        fixtures.push(("tiled-129s-composite".to_string(), composite));

        let mut max_abs_delta = 0.0_f32;
        let mut min_margin = f32::MAX;
        let mut total_frames = 0usize;
        let mut default_ns = 0u128;
        let mut tuned_ns = 0u128;
        for (name, audio) in &fixtures {
            let t0 = std::time::Instant::now();
            let base_probs = baseline
                .frame_probs(audio)
                .unwrap_or_else(|e| panic!("baseline frame_probs {name}: {e}"));
            default_ns += t0.elapsed().as_nanos();

            let t1 = std::time::Instant::now();
            let tuned_probs = tuned
                .frame_probs(audio)
                .unwrap_or_else(|e| panic!("tuned frame_probs {name}: {e}"));
            tuned_ns += t1.elapsed().as_nanos();

            assert_eq!(
                base_probs.len(),
                tuned_probs.len(),
                "{name}: frame count differs"
            );
            for (i, (&b, &t)) in base_probs.iter().zip(&tuned_probs).enumerate() {
                max_abs_delta = max_abs_delta.max((b - t).abs());
                min_margin = min_margin.min((b - 0.5).abs());
                assert_eq!(
                    b.to_bits(),
                    t.to_bits(),
                    "{name} frame {i}: default={b} tuned={t} (bit-for-bit mismatch)"
                );
            }
            total_frames += base_probs.len();
        }

        eprintln!(
            "#990 measurement -- {total_frames} frames: default {:.1}ms ({:.1}us/frame), tuned {:.1}ms ({:.1}us/frame), max|dp|={max_abs_delta:e}, min|p-0.5|={min_margin:e}",
            default_ns as f64 / 1e6,
            default_ns as f64 / total_frames as f64 / 1e3,
            tuned_ns as f64 / 1e6,
            tuned_ns as f64 / total_frames as f64 / 1e3,
        );
    }
}
