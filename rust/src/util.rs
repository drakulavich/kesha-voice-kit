//! Tiny shared helpers used across modules.

/// Index of the largest f32 in a slice. Ties pick the lowest index.
///
/// Only the ONNX ASR backend (`backend::onnx`, Parakeet TDT) uses this today;
/// the ByT5 G2P consumer was removed in #213. The gate mirrors that module's
/// own `#[cfg(all(feature = "onnx", not(feature = "coreml")))]` in
/// `backend/mod.rs` exactly: with both `onnx` and `coreml` enabled the ONNX
/// backend is cfg'd out, so gating on `onnx` alone would compile `argmax` with
/// no caller and trip clippy's `dead_code` lint under `-D warnings`.
#[cfg(all(feature = "onnx", not(feature = "coreml")))]
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
