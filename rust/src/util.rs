//! Tiny shared helpers used across modules.

/// Index of the largest f32 in a slice. Ties pick the lowest index.
/// Shared by `tts::g2p` (ByT5 decoder) and `backend::onnx` (Parakeet TDT).
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
