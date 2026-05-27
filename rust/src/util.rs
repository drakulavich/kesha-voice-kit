//! Tiny shared helpers used across modules.

/// Index of the largest f32 in a slice. Ties pick the lowest index.
///
/// Only the ONNX ASR backend (`backend::onnx`, Parakeet TDT) uses this today;
/// the ByT5 G2P consumer was removed in #213. Gate it on `onnx` so the
/// darwin-arm64 `coreml`/`system_kokoro` feature set (which doesn't build the
/// ONNX backend) doesn't trip clippy's `dead_code` lint under `-D warnings`.
#[cfg(feature = "onnx")]
pub fn argmax(xs: &[f32]) -> usize {
    let mut best = 0;
    let mut best_v = f32::NEG_INFINITY;
    for (i, &v) in xs.iter().enumerate() {
        if v > best_v {
            best_v = v;
            best = i;
        }
    }
    best
}
