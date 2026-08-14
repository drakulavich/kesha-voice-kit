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

    /// Crate-wide lock for every env-mutating test.
    pub struct EnvLock {
        _guard: MutexGuard<'static, ()>,
    }

    /// Acquires the crate-wide env lock. Poisoning is ignored so a panicked
    /// env test does not cascade into unrelated ones.
    pub fn lock() -> EnvLock {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        EnvLock {
            _guard: LOCK
                .get_or_init(|| Mutex::new(()))
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        }
    }

    /// Restores the env var to its original value on drop while its borrowed
    /// [`EnvLock`] keeps env mutation serialized.
    pub struct EnvGuard<'lock> {
        key: &'static str,
        original: Option<String>,
        _lock: std::marker::PhantomData<&'lock EnvLock>,
    }

    impl<'lock> EnvGuard<'lock> {
        pub fn set(_lock: &'lock EnvLock, key: &'static str, val: &str) -> Self {
            let original = std::env::var(key).ok();
            // SAFETY: the borrowed `EnvLock` serializes every env-mutating test in the crate.
            unsafe { std::env::set_var(key, val) };
            Self {
                key,
                original,
                _lock: std::marker::PhantomData,
            }
        }

        pub fn unset(_lock: &'lock EnvLock, key: &'static str) -> Self {
            let original = std::env::var(key).ok();
            // SAFETY: the borrowed `EnvLock` serializes every env-mutating test in the crate.
            unsafe { std::env::remove_var(key) };
            Self {
                key,
                original,
                _lock: std::marker::PhantomData,
            }
        }
    }

    impl Drop for EnvGuard<'_> {
        fn drop(&mut self) {
            // `EnvGuard` cannot outlive its borrowed `EnvLock`.
            match &self.original {
                // SAFETY: restoration runs under that still-held lock, like the set did.
                Some(v) => unsafe { std::env::set_var(self.key, v) },
                // SAFETY: restoration runs under that still-held lock, like the unset did.
                None => unsafe { std::env::remove_var(self.key) },
            }
        }
    }

    #[test]
    fn env_guard_mutators_require_a_borrowed_env_lock() {
        fn set<'lock>(lock: &'lock EnvLock) -> EnvGuard<'lock> {
            EnvGuard::set(lock, "KESHA_TEST_ENV_GUARD", "value")
        }

        fn unset<'lock>(lock: &'lock EnvLock) -> EnvGuard<'lock> {
            EnvGuard::unset(lock, "KESHA_TEST_ENV_GUARD")
        }

        let lock = lock();
        drop(set(&lock));
        drop(unset(&lock));
    }
}
