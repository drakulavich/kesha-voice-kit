use crate::audio;
use crate::coded_bail;
use crate::errors::{CodedContext, ErrorCode};
use crate::models;
use anyhow::{Context, Result};
use serde::Serialize;

#[derive(Serialize)]
pub struct LangDetectResult {
    pub code: String,
    pub confidence: f32,
}

const MAX_SECONDS: f32 = 10.0;

pub fn detect_audio_language(audio_path: &str) -> Result<LangDetectResult> {
    audio::ensure_audio_track(audio_path)?;

    let dir = lang_id_model_dir(models::cache_dir())?;

    // Load ONNX session
    let mut session = ort::session::Session::builder()
        .context("failed to create lang-id session builder")
        .coded(ErrorCode::ModelLoad)?
        .commit_from_file(dir.join("lang-id-ecapa.onnx"))
        .context("failed to load lang-id model")
        .coded(ErrorCode::ModelLoad)?;

    // Load labels
    let labels: Vec<String> = {
        let data = std::fs::read_to_string(dir.join("labels.json"))?;
        serde_json::from_str(&data)?
    };

    // Load audio (first 10s)
    let samples = audio::load_audio_truncated(audio_path, MAX_SECONDS)?;

    // Run inference
    // Input: "waveform" [1, samples] float32
    // Output: "language_probs" [1, 107] float32
    let input_len = samples.len();
    let waveform =
        ort::value::Value::from_array(ndarray::Array2::from_shape_vec((1, input_len), samples)?)?;

    let outputs = session.run(ort::inputs!["waveform" => waveform])?;

    // Extract probs - same pattern as onnx.rs: try_extract_tensor returns (&Shape, &[T])
    let (_, probs_data) = outputs[0]
        .try_extract_tensor::<f32>()
        .context("failed to extract language_probs tensor")?;

    // Find argmax
    let mut best_idx = 0;
    let mut best_val = f32::NEG_INFINITY;
    for (i, &val) in probs_data.iter().enumerate() {
        if val > best_val {
            best_val = val;
            best_idx = i;
        }
    }

    Ok(LangDetectResult {
        code: labels.get(best_idx).cloned().unwrap_or_default(),
        confidence: best_val,
    })
}

/// The lang-id model dir, or the reason there isn't one. Takes the cache-root
/// resolution rather than reading it, so the null-home failure #953 coded as
/// `E_INTERNAL` stays an environment error instead of being reported as a
/// missing model (#969) — and so that ordering is testable.
fn lang_id_model_dir(cache: Result<std::path::PathBuf>) -> Result<std::path::PathBuf> {
    let dir = models::model_dir_at(models::ModelKind::LangId, &cache?);
    if !models::is_cached_in(models::ModelKind::LangId, &dir) {
        coded_bail!(
            ErrorCode::ModelMissing,
            "Lang-ID model not installed. Run: kesha install"
        );
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::code_of;

    #[test]
    fn missing_audio_fails_before_model_lookup() {
        let err = match detect_audio_language("/nonexistent/kesha/lang-id.wav") {
            Ok(_) => panic!("missing audio should fail before lang-id model lookup"),
            Err(err) => err,
        };
        let msg = format!("{err:#}");
        assert!(
            !msg.contains("Lang-ID model not installed"),
            "input validation must happen before model lookup, got: {msg}"
        );
    }

    // #969: no resolvable home means we cannot tell whether the model is there,
    // so the verdict is the environment failure, never "install the model".
    #[test]
    fn unresolvable_home_is_coded_internal_not_model_missing() {
        let err = lang_id_model_dir(models::cache_dir_from(None, None))
            .expect_err("a null home cannot yield a lang-id model dir");
        assert_eq!(code_of(&err), ErrorCode::Internal);
        let msg = format!("{err:#}");
        assert!(
            !msg.contains("not installed"),
            "a home failure must not be reported as a missing model: {msg}"
        );
        assert!(
            msg.contains("KESHA_CACHE_DIR"),
            "message must name the escape hatch: {msg}"
        );
    }
}
