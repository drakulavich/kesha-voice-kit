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

fn mini_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tests/fixtures/mini-models/kokoro")
}

#[test]
fn a_mini_staged_lane_is_distinguishable_from_a_real_one() {
    assert!(
        common::staged_with_mini_models(&mini_dir().join("model.onnx")),
        "the committed mini must carry its marker, or KESHA_REQUIRE_MODEL_TESTS \
         would accept it as real coverage"
    );
    assert!(
        !common::staged_with_mini_models(std::path::Path::new("/nonexistent/model.onnx")),
        "an unmarked path is treated as real"
    );
}

/// say-e2e stages by symlinking the model into a temp cache, which leaves the
/// marker behind at the target — the shape that would otherwise read as real.
#[cfg(unix)]
#[test]
fn a_symlinked_mini_is_still_recognised_as_a_stand_in() {
    let staged = std::env::temp_dir().join(format!("kesha-mini-link-{}", std::process::id()));
    let dir = staged.join("models/kokoro-82m");
    std::fs::create_dir_all(&dir).unwrap();
    let link = dir.join("model.onnx");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(mini_dir().join("model.onnx"), &link).unwrap();

    assert!(
        !link.parent().unwrap().join("MINI-MODEL.json").exists(),
        "the staging dir must not carry the marker, or this proves nothing"
    );
    assert!(
        common::staged_with_mini_models(&link),
        "a symlinked mini must still be recognised through its target"
    );
    std::fs::remove_dir_all(&staged).ok();
}

/// Every gate entry point, not just the one that had it first: a lane that
/// promised real models must fail on a stand-in wherever it enters.
#[test]
fn every_gate_refuses_a_mini_when_the_lane_promised_real_models() {
    let mini = mini_dir();
    let staged = std::env::temp_dir().join(format!("kesha-mini-gate-{}", std::process::id()));
    let dir = staged.join("models/kokoro-82m/voices");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(
        mini.join("model.onnx"),
        staged.join("models/kokoro-82m/model.onnx"),
    )
    .unwrap();
    std::fs::copy(mini.join("am_michael.bin"), dir.join("am_michael.bin")).unwrap();
    std::fs::copy(
        mini.join("MINI-MODEL.json"),
        staged.join("models/kokoro-82m/MINI-MODEL.json"),
    )
    .unwrap();

    std::env::set_var("KESHA_CACHE_DIR", &staged);
    std::env::set_var("KOKORO_MODEL", mini.join("model.onnx"));
    std::env::set_var("KOKORO_VOICE", mini.join("am_michael.bin"));

    std::env::remove_var("KESHA_REQUIRE_MODEL_TESTS");
    assert!(
        common::kokoro_paths_or_skip().is_some() && common::kokoro_cache_dir_or_skip().is_some(),
        "a lane that promised nothing may use minis freely"
    );

    std::env::set_var("KESHA_REQUIRE_MODEL_TESTS", "1");
    let by_env = std::panic::catch_unwind(common::kokoro_paths_or_skip);
    let by_cache = std::panic::catch_unwind(common::kokoro_cache_dir_or_skip);
    let by_voice = std::panic::catch_unwind(|| common::kokoro_voice_or_skip(&staged, "am_michael"));

    // The other direction: a lane that meant to run on stand-ins must not slip
    // back to paying for real weights unnoticed.
    std::env::set_var("KESHA_REQUIRE_MODEL_TESTS", "mini");
    let minis_accepted = std::panic::catch_unwind(common::kokoro_cache_dir_or_skip);
    std::fs::remove_file(staged.join("models/kokoro-82m/MINI-MODEL.json")).unwrap();
    let real_where_mini_promised = std::panic::catch_unwind(common::kokoro_cache_dir_or_skip);

    std::env::remove_var("KESHA_REQUIRE_MODEL_TESTS");
    std::env::remove_var("KESHA_CACHE_DIR");
    std::env::remove_var("KOKORO_MODEL");
    std::env::remove_var("KOKORO_VOICE");
    std::fs::remove_dir_all(&staged).ok();

    assert!(by_env.is_err(), "kokoro_paths_or_skip must refuse a mini");
    assert!(
        by_cache.is_err(),
        "kokoro_cache_dir_or_skip must refuse a mini"
    );
    assert!(by_voice.is_err(), "kokoro_voice_or_skip must refuse a mini");
    assert!(
        matches!(minis_accepted, Ok(Some(_))),
        "a lane that asked for minis must accept them"
    );
    assert!(
        real_where_mini_promised.is_err(),
        "a lane that asked for minis must refuse unmarked (real) weights"
    );
}

/// The reverse direction at the other two entry points, and the cell neither the
/// tier nor the marker covers: `mini` promised with nothing staged at all, which
/// must still fail rather than skip.
#[test]
fn the_other_gates_refuse_real_weights_and_an_empty_layout_when_minis_were_promised() {
    let empty = std::env::temp_dir().join(format!("kesha-mini-rev-{}", std::process::id()));
    let voices = empty.join("models/kokoro-82m/voices");
    std::fs::create_dir_all(&voices).unwrap();
    // Unmarked, so these read as real weights.
    std::fs::write(empty.join("models/kokoro-82m/model.onnx"), b"stub").unwrap();
    std::fs::write(voices.join("am_michael.bin"), b"stub").unwrap();
    std::fs::write(voices.join("em_alex.bin"), b"stub").unwrap();

    std::env::set_var("KOKORO_MODEL", empty.join("models/kokoro-82m/model.onnx"));
    std::env::set_var("KOKORO_VOICE", voices.join("am_michael.bin"));
    std::env::set_var("KESHA_REQUIRE_MODEL_TESTS", "mini");
    let by_env = std::panic::catch_unwind(common::kokoro_paths_or_skip);
    let by_voice = std::panic::catch_unwind(|| common::kokoro_voice_or_skip(&empty, "em_alex"));

    // Nothing staged at all: the tier is promised and no gate can resolve.
    std::env::remove_var("KOKORO_MODEL");
    std::env::remove_var("KOKORO_VOICE");
    std::env::set_var("KESHA_CACHE_DIR", empty.join("nowhere"));
    let nothing_staged = std::panic::catch_unwind(common::kokoro_cache_dir_or_skip);

    std::env::remove_var("KESHA_REQUIRE_MODEL_TESTS");
    std::env::remove_var("KESHA_CACHE_DIR");
    std::fs::remove_dir_all(&empty).ok();

    assert!(
        by_env.is_err(),
        "kokoro_paths_or_skip must refuse real weights on a mini lane"
    );
    assert!(
        by_voice.is_err(),
        "kokoro_voice_or_skip must refuse real weights on a mini lane"
    );
    assert!(
        nothing_staged.is_err(),
        "a promised tier with nothing staged must fail, not skip"
    );
}

#[test]
fn the_flag_names_which_weights_a_lane_promised() {
    use common::RequiredModels::{Mini, Real};
    assert_eq!(common::required_models(None), None);
    assert_eq!(common::required_models(Some("")), None);
    assert_eq!(common::required_models(Some("0")), None);
    assert_eq!(common::required_models(Some("mini")), Some(Mini));
    assert_eq!(common::required_models(Some("MINI")), Some(Mini));
    assert_eq!(common::required_models(Some("1")), Some(Real));
    assert_eq!(common::required_models(Some("real")), Some(Real));
}

/// Groups its assertions rather than splitting them because it mutates process
/// env, which is only safe under nextest's process-per-test — the runner
/// CLAUDE.md mandates. Plain `cargo test` would race this against the other
/// env-mutating test in this file.
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
