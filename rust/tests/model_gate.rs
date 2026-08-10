//! Guard for the model-gate policy the TTS test files share.
//!
//! A gate that returns `None` makes its callers return early, which nextest
//! reports as a pass. That is right for a laptop with no models staged and
//! wrong for a CI lane that just downloaded them: #741 found `run-cargo-test.sh`
//! exporting `KESHA_CACHE_DIR` off the presence of a bundle no test reads, so
//! removing that bundle would have silently stopped five tests from running
//! while the lane stayed green. `KESHA_REQUIRE_MODEL_TESTS` turns that silence
//! into a failure in the lanes that promise to stage models.

mod common;

#[test]
fn a_missing_model_skips_by_default_and_fails_where_models_are_promised() {
    assert!(!common::missing_model_is_fatal(None));
    assert!(!common::missing_model_is_fatal(Some("")));
    assert!(!common::missing_model_is_fatal(Some("0")));
    assert!(common::missing_model_is_fatal(Some("1")));
}

#[test]
fn the_kokoro_gate_fails_loudly_rather_than_skipping_when_models_are_promised() {
    let empty = std::env::temp_dir().join(format!("kesha-model-gate-{}", std::process::id()));
    std::fs::create_dir_all(&empty).expect("temp cache root");
    std::env::set_var("KESHA_CACHE_DIR", &empty);

    std::env::remove_var("KESHA_REQUIRE_MODEL_TESTS");
    assert!(
        common::kokoro_cache_dir_or_skip().is_none(),
        "an unstaged laptop must still skip"
    );

    std::env::set_var("KESHA_REQUIRE_MODEL_TESTS", "1");
    let outcome = std::panic::catch_unwind(common::kokoro_cache_dir_or_skip);
    std::env::remove_var("KESHA_REQUIRE_MODEL_TESTS");
    std::fs::remove_dir_all(&empty).ok();

    assert!(
        outcome.is_err(),
        "a lane that staged models must fail on an unreadable layout, not skip"
    );
}
