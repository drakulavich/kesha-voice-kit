//! Scoped warn-once helper.
//!
//! Engine-agnostic: called from the SSML parser (`tts::ssml`), the Russian-
//! Vosk normalization, and the Kokoro / Vosk defensive arms in `tts::say`.
//! Emits a single stderr line per `key` per **scope**. A scope is bounded by:
//!
//! - one-shot CLI process — implicit (the process exits before a second
//!   call could repeat); historical behavior.
//! - one `say_loop::handle()` request — explicit, via [`reset()`] at the
//!   top of each request, so a user feeding the same SSML twice over
//!   the `--stdin-loop` protocol sees the warning twice. Without this,
//!   long-lived processes silently swallowed the second invocation
//!   (#267 F15 / #311).
//!
//! Two key shapes are supported via the relaxed `&str` signature:
//!
//! - **Constant keys** (e.g. `WARN_PROSODY_MID_UTTERANCE`) — preferred. The
//!   set of distinct warnings is bounded; one allocation per scope.
//! - **Dynamic keys** (e.g. `phoneme[alphabet=x-sampa]`, `say-as[interpret-as=cardinal]`,
//!   `unknown-tag-paragraph`) — used by SSML's open-ended attribute spaces.
//!   One allocation per *unique* combination per scope.
//!
//! Lock poisoning is treated as fatal — at that point another thread panicked
//! while holding the lock and the process is in an unrecoverable state.
//!
//! **Test isolation:** `cargo nextest run` spawns a fresh process per test
//! and gets the empty-scope baseline automatically. For `cargo test --lib`
//! (single-process runner) test authors who need a clean scope inside one
//! test can call [`reset()`] in the test's setup; the function is
//! `pub(crate)` for this purpose.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

fn warned() -> &'static Mutex<HashSet<String>> {
    static W: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn warn_once(key: &str, msg: &str) {
    let mut set = warned().lock().expect("warn_once: mutex poisoned");
    if !set.contains(key) {
        set.insert(key.to_string());
        eprintln!("warning: {msg}");
    }
}

#[cfg(test)]
pub(crate) fn was_warned(key: &str) -> bool {
    warned()
        .lock()
        .expect("was_warned: mutex poisoned")
        .contains(key)
}

/// `dead_code`: `say_loop` links only into the bin target, not `lib.rs`; exercised by tests.
#[allow(dead_code)]
pub(crate) fn reset() {
    warned().lock().expect("reset: mutex poisoned").clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warn_once_dedups_by_key() {
        let key = "test-warn-once-key-1";
        warn_once(key, "first call — should print once and remember the key");
        assert!(
            warned().lock().unwrap().contains(key),
            "warn_once must record the key it warned for"
        );
        warn_once(key, "second call — should be a silent no-op");
        let still_present = warned().lock().unwrap().contains(key);
        assert!(still_present, "key remains in the set across calls");
        let probe = warned().lock().unwrap().insert(key.to_string());
        assert!(!probe, "key already present after warn_once recorded it");
    }

    #[test]
    fn warn_once_different_keys_each_fire() {
        warn_once("test-warn-once-key-2a", "first key");
        warn_once("test-warn-once-key-2b", "second key");
        let set = warned().lock().unwrap();
        assert!(set.contains("test-warn-once-key-2a"));
        assert!(set.contains("test-warn-once-key-2b"));
    }

    #[test]
    fn reset_clears_the_scope_so_subsequent_warns_fire_again() {
        // Use a key unique to this test so it doesn't collide with the dedup
        // tests above when run in a shared process (cargo test --lib).
        let key = "test-warn-once-reset-key";
        warn_once(key, "first fire — should record the key");
        assert!(was_warned(key), "key should be recorded after first warn");

        reset();
        assert!(
            !was_warned(key),
            "reset() should clear the scope, but key is still present"
        );

        warn_once(key, "second fire — should re-record after reset");
        assert!(was_warned(key), "key should be recorded after second warn");
    }
}
