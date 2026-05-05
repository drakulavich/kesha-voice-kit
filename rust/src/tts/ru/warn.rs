//! Per-process warn-once helper for SSML feature gates.
//!
//! Used by the emphasis (#233) and acronym (#232) paths to emit a single
//! stderr line when a non-fatal SSML feature is misused (e.g. `<emphasis>`
//! content without a `+vowel` marker). Dedup is keyed by a `&'static str`
//! identifier so all instances of the same warning across `kesha say`
//! invocations within the same process print only once.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

// `warned` and `warn_once` are called by T4 (#233) warn-once arms in tts/mod.rs.
// Until that wiring lands they are unreferenced from production code; the tests
// below exercise `warned()` directly. Allow dead_code rather than suppress the
// lint site-by-site in callers that don't exist yet.
#[allow(dead_code)]
fn warned() -> &'static Mutex<HashSet<&'static str>> {
    static W: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Emit `msg` to stderr if `key` has not been warned in this process.
/// Subsequent calls with the same `key` are silent. Lock poisoning is
/// treated as fatal — at that point another thread panicked while
/// holding the lock and the process is in an unrecoverable state.
#[allow(dead_code)]
pub fn warn_once(key: &'static str, msg: &str) {
    let mut set = warned().lock().expect("warn_once: mutex poisoned");
    if set.insert(key) {
        eprintln!("warning: {msg}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warn_once_dedups_by_key() {
        let key = "test-warn-once-key-1";
        let mut set = warned().lock().unwrap();
        assert!(set.insert(key));
        assert!(!set.insert(key));
    }

    #[test]
    fn warn_once_different_keys_each_fire() {
        let mut set = warned().lock().unwrap();
        assert!(set.insert("test-warn-once-key-2a"));
        assert!(set.insert("test-warn-once-key-2b"));
    }
}
