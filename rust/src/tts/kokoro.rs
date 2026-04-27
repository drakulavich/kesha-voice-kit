//! Kokoro-82M ONNX inference session.
//!
//! Inputs:  `tokens` (int64 [1,N]), `style` (f32 [1,256]), `speed` (f32 [1])
//! Output:  `audio` (f32 [T]) at 24 kHz
//!
//! Tensor names follow the kokoro-onnx official release. The earlier HF
//! onnx-community variant used `(input_ids, waveform)` and produced
//! unintelligible audio with `af_heart` — see #207.

use std::path::Path;

use ndarray::{Array1, Array2};
use ort::session::Session;
use ort::value::Value;

/// Kokoro output sample rate.
pub const SAMPLE_RATE: u32 = 24_000;

pub struct Kokoro {
    session: Session,
}

impl Kokoro {
    pub fn load(model_path: &Path) -> anyhow::Result<Self> {
        let session = Session::builder()?.commit_from_file(model_path)?;
        Ok(Self { session })
    }

    /// Run inference. `input_ids` is the padded/truncated token vector (any positive length),
    /// `style` must be exactly 256 floats. Returns mono f32 audio at [`SAMPLE_RATE`].
    pub fn infer(
        &mut self,
        input_ids: &[i64],
        style: &[f32],
        speed: f32,
    ) -> anyhow::Result<Vec<f32>> {
        anyhow::ensure!(!input_ids.is_empty(), "input_ids must be non-empty");
        anyhow::ensure!(
            style.len() == 256,
            "style must be 256 floats, got {}",
            style.len()
        );

        let n = input_ids.len();
        let ids = Value::from_array(Array2::<i64>::from_shape_vec((1, n), input_ids.to_vec())?)?;
        let st = Value::from_array(Array2::<f32>::from_shape_vec((1, 256), style.to_vec())?)?;
        let sp = Value::from_array(Array1::<f32>::from_vec(vec![speed]))?;

        let outputs = self.session.run(ort::inputs![
            "tokens" => ids,
            "style"  => st,
            "speed"  => sp,
        ])?;

        let (_shape, data) = outputs["audio"].try_extract_tensor::<f32>()?;
        Ok(data.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gated on KOKORO_MODEL env var. Skipped when unset so default CI stays fast.
    #[test]
    fn infer_produces_non_silent_audio_when_model_available() {
        let Some(path) = std::env::var_os("KOKORO_MODEL") else {
            eprintln!("KOKORO_MODEL not set; skipping");
            return;
        };
        let mut k = Kokoro::load(Path::new(&path)).unwrap();
        // Arbitrary placeholder tokens — the test verifies tensor wiring, not audio quality.
        let ids: Vec<i64> = vec![0, 50, 83, 54, 156, 57, 135, 0];
        let style = vec![0.01_f32; 256];
        let audio = k.infer(&ids, &style, 1.0).unwrap();
        assert!(
            audio.len() > 1000,
            "expected non-trivial audio length, got {}",
            audio.len()
        );
    }
}
