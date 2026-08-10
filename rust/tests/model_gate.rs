//! Guard for the model-gate policy the TTS test files share.
//!
//! A gate that returns `None` makes its callers return early, which nextest
//! reports as a pass. That is right for a laptop with no models staged and
//! wrong for a CI lane that just downloaded them: #741 found `run-cargo-test.sh`
//! exporting `KESHA_CACHE_DIR` off the presence of a bundle no test reads, so
//! removing that bundle would have silently stopped four tests from running
//! while the lane stayed green. `KESHA_REQUIRE_MODEL_TESTS` turns that silence
//! into a failure in the lanes that promise to stage models.
//!
//! The rule is meant to be complete: every model-gated skip site either asserts
//! the flag or is listed here as deliberately exempt. Exempt today:
//! `kokoro_rate_e2e.rs` and `diarize_e2e.rs` (ANE/Sortformer bundles no lane
//! stages), `vosk.rs`'s synth test (its own `KESHA_REQUIRE_VOSK_TESTS`, since
//! only one lane carries that bundle), and the `KESHA_*` env skips inside
//! `rust/src/tts/` — those sit behind integration gates that already fail loudly,
//! so covering them is defense-in-depth for a later stage, not a hole today.

mod common;

#[test]
fn a_missing_model_skips_by_default_and_fails_where_models_are_promised() {
    assert!(!common::missing_model_is_fatal(None));
    assert!(!common::missing_model_is_fatal(Some("")));
    assert!(!common::missing_model_is_fatal(Some("0")));
    assert!(common::missing_model_is_fatal(Some("1")));
}

/// Both gates live in one test because it mutates process env: nextest gives
/// each test its own process, but plain `cargo test` would race them.
#[test]
fn the_kokoro_gates_fail_loudly_rather_than_skipping_when_models_are_promised() {
    let root = std::env::temp_dir().join(format!("kesha-model-gate-{}", std::process::id()));
    let voices = root.join("models/kokoro-82m/voices");
    std::fs::create_dir_all(&voices).expect("temp cache root");
    std::env::set_var("KESHA_CACHE_DIR", &root);
    std::env::remove_var("KESHA_REQUIRE_MODEL_TESTS");

    assert!(
        common::kokoro_cache_dir_or_skip().is_none(),
        "an unstaged laptop must still skip"
    );

    // A cache that has the graph and the default voice but not a multilang one:
    // the cache-dir gate passes and only the per-voice gate can catch it.
    std::fs::write(root.join("models/kokoro-82m/model.onnx"), b"stub").expect("graph");
    std::fs::write(voices.join("am_michael.bin"), b"stub").expect("default voice");
    assert!(
        common::kokoro_cache_dir_or_skip().is_some(),
        "graph + default voice present, so the cache-dir gate must pass"
    );
    assert!(
        common::kokoro_voice_or_skip(&root, "em_alex").is_none(),
        "a missing multilang voice must still skip on an unstaged laptop"
    );

    std::env::set_var("KESHA_REQUIRE_MODEL_TESTS", "1");
    let voice_outcome = std::panic::catch_unwind(|| common::kokoro_voice_or_skip(&root, "em_alex"));
    std::fs::remove_file(root.join("models/kokoro-82m/model.onnx")).expect("unstage graph");
    let cache_outcome = std::panic::catch_unwind(common::kokoro_cache_dir_or_skip);
    std::env::remove_var("KESHA_REQUIRE_MODEL_TESTS");
    std::fs::remove_dir_all(&root).ok();

    assert!(
        voice_outcome.is_err(),
        "a missing voice pack must fail the lane, not skip it"
    );
    assert!(
        cache_outcome.is_err(),
        "a lane that staged models must fail on an unreadable layout, not skip"
    );
}
