//! Silero VAD v5 ONNX wrapper — turns a 16 kHz mono f32 waveform into
//! `(start_s, end_s)` speech segments (#128).
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
pub const FRAME_SAMPLES: usize = 512; // 32 ms @ 16 kHz
/// v5 requires a 64-sample rolling context prepended to each 512-sample
/// frame — the ONNX input is therefore length 576, even though the API
/// nominally "takes 512 samples at 16 kHz". Missing this makes the model
/// output ~0 for everything (matches upstream's Python `OnnxWrapper`).
const CONTEXT_SAMPLES: usize = 64;
const INPUT_SAMPLES: usize = CONTEXT_SAMPLES + FRAME_SAMPLES;
const STATE_SHAPE: (usize, usize, usize) = (2, 1, 128);

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

pub struct VadDetector {
    session: Session,
}

impl VadDetector {
    pub fn load(model_path: &Path) -> Result<Self> {
        let session = Session::builder()
            .context("failed to create VAD session builder")?
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

    /// Run the ONNX session per 512-sample frame (with a 64-sample rolling
    /// context prepended — see `CONTEXT_SAMPLES`) and collect the speech
    /// probability for each. The final partial frame is zero-padded.
    fn frame_probs(&mut self, audio: &[f32]) -> Result<Vec<f32>> {
        let mut state = vec![0.0_f32; STATE_SHAPE.0 * STATE_SHAPE.1 * STATE_SHAPE.2];
        // Rolling 64-sample context starts as zeros and is updated to the
        // last 64 samples of each processed chunk (matches upstream's
        // `OnnxWrapper.__call__` in silero_vad/utils_vad.py).
        let mut context = vec![0.0_f32; CONTEXT_SAMPLES];
        let mut probs: Vec<f32> = Vec::with_capacity(audio.len().div_ceil(FRAME_SAMPLES));
        let mut input_buf = vec![0.0_f32; INPUT_SAMPLES];
        let mut chunk_buf = vec![0.0_f32; FRAME_SAMPLES];

        for chunk in audio.chunks(FRAME_SAMPLES) {
            // Zero-pad the last partial chunk in the chunk buffer itself so
            // the context update below always sees a 512-sample slice.
            chunk_buf[..chunk.len()].copy_from_slice(chunk);
            if chunk.len() < FRAME_SAMPLES {
                chunk_buf[chunk.len()..].fill(0.0);
            }

            input_buf[..CONTEXT_SAMPLES].copy_from_slice(&context);
            input_buf[CONTEXT_SAMPLES..].copy_from_slice(&chunk_buf);

            let input = Value::from_array(Array2::<f32>::from_shape_vec(
                (1, INPUT_SAMPLES),
                input_buf.clone(),
            )?)?;
            let state_val =
                Value::from_array(Array3::<f32>::from_shape_vec(STATE_SHAPE, state.clone())?)?;
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
            probs.push(prob_data[0]);

            let (_state_shape, state_data) = outputs["stateN"].try_extract_tensor::<f32>()?;
            state = state_data.to_vec();

            // Context for the next iteration = last 64 samples of the
            // (possibly zero-padded) current chunk.
            context.copy_from_slice(&chunk_buf[FRAME_SAMPLES - CONTEXT_SAMPLES..]);
        }

        Ok(probs)
    }
}

/// Frame probs → smoothed speech segments. Pure function, no ONNX — easy
/// to unit-test without the model file.
fn post_process(
    probs: &[f32],
    total_samples: usize,
    cfg: VadConfig,
    sample_rate: u32,
) -> Vec<(f32, f32)> {
    if probs.is_empty() || total_samples == 0 {
        return vec![];
    }

    // Step 1 — threshold each frame, collect raw speech spans (in samples).
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

    // Step 2 — merge spans separated by < min_silence. Operates in sample
    // space so we don't accumulate rounding error converting back and forth.
    let min_silence = ms_to_samples(cfg.min_silence_ms, sample_rate);
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(spans.len());
    for (s, e) in spans {
        match merged.last_mut() {
            Some(last) if s.saturating_sub(last.1) < min_silence => last.1 = e,
            _ => merged.push((s, e)),
        }
    }

    // Step 3 — drop spans shorter than min_speech.
    let min_speech = ms_to_samples(cfg.min_speech_ms, sample_rate);
    merged.retain(|(s, e)| e.saturating_sub(*s) >= min_speech);

    // Step 4 — pad each span, clamp to [0, total_samples], convert to seconds.
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
        // Speech pad clamps to [0, total]; full-speech input should span the file.
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
}
