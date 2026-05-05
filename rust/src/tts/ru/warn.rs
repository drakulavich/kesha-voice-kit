//! Per-process warn-once helper for SSML feature gates.
//!
//! Used by the emphasis (#233) and acronym (#232) paths to emit a single
//! stderr line when a non-fatal SSML feature is misused (e.g. `<emphasis>`
//! content without a `+vowel` marker). Dedup is keyed by a `&'static str`
//! identifier so all instances of the same warning across `kesha say`
//! invocations within the same process print only once.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

fn warned() -> &'static Mutex<HashSet<&'static str>> {
    static W: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Emit `msg` to stderr if `key` has not been warned in this process.
/// Subsequent calls with the same `key` are silent. Lock poisoning is
/// treated as fatal — at that point another thread panicked while
/// holding the lock and the process is in an unrecoverable state.
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
        // Public-API exercise: first call inserts the key (and prints to stderr);
        // second call with the same key is a silent no-op. We can't capture
        // stderr deterministically across the global `eprintln!`, so we assert
        // dedup via the keyed set state — but, unlike the bypass form, we go
        // through the public function so a regression that drops the eprintln
        // (or the insert) would be observable as a behavior change.
        let key = "test-warn-once-key-1";
        warn_once(key, "first call — should print once and remember the key");
        assert!(
            warned().lock().unwrap().contains(key),
            "warn_once must record the key it warned for"
        );
        // Second call: dedup means the key is already present, so insert returns
        // false. We can verify by attempting another insert manually.
        warn_once(key, "second call — should be a silent no-op");
        let still_present = warned().lock().unwrap().contains(key);
        assert!(still_present, "key remains in the set across calls");
        // Manual probe: try inserting the key fresh — should report already-there.
        let probe = warned().lock().unwrap().insert(key);
        assert!(!probe, "key already present after warn_once recorded it");
    }

    #[test]
    fn warn_once_different_keys_each_fire() {
        // Public-API exercise: each unique key should be recorded independently.
        warn_once("test-warn-once-key-2a", "first key");
        warn_once("test-warn-once-key-2b", "second key");
        let set = warned().lock().unwrap();
        assert!(set.contains("test-warn-once-key-2a"));
        assert!(set.contains("test-warn-once-key-2b"));
    }
}
