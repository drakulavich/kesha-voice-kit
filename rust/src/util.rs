//! Tiny shared helpers used across modules.

/// Index of the largest f32 in a slice. Ties pick the lowest index.
///
/// Only the ONNX ASR backend (`backend::onnx`, Parakeet TDT) uses this today;
/// the ByT5 G2P consumer was removed in #214. The gate mirrors that module's
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

/// Test-only env mutation helpers. Env-mutating tests across the crate must
/// serialize on [`test_env::lock`] — previously three modules kept private
/// mutexes, so their tests could still race each other in one process.
#[cfg(test)]
pub mod test_env {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// Crate-wide lock for every env-mutating test. Poisoning is ignored:
    /// a panicked env test must not cascade into unrelated ones.
    pub fn lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Restores the env var to its original value on drop. Hold the guard
    /// from [`lock`] for the whole test — `EnvGuard` deliberately does not
    /// take it itself so a test can set several vars.
    pub struct EnvGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvGuard {
        pub fn set(key: &'static str, val: &str) -> Self {
            let original = std::env::var(key).ok();
            // SAFETY: the caller holds [`lock`], so no other test thread touches the environment.
            unsafe { std::env::set_var(key, val) };
            Self { key, original }
        }

        pub fn unset(key: &'static str) -> Self {
            let original = std::env::var(key).ok();
            // SAFETY: the caller holds [`lock`], so no other test thread touches the environment.
            unsafe { std::env::remove_var(key) };
            Self { key, original }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // Locals drop in reverse order, so a test that took [`lock`] first still holds it here.
            match &self.original {
                // SAFETY: restoration is serialized by that still-held lock, like the set was.
                Some(v) => unsafe { std::env::set_var(self.key, v) },
                // SAFETY: restoration is serialized by that still-held lock, like the unset was.
                None => unsafe { std::env::remove_var(self.key) },
            }
        }
    }
}
