//! Committed golden VAD spans through the public `detect_segments`.
//!
//! VAD spans feed `TranscriptionSegment.start/.end`, which feeds `--timestamps`,
//! `--json` and diarization span assignment, so they are a user-visible contract
//! rather than an implementation detail. #990 changes the Silero session's
//! thread configuration; this file is what proves the spans did not move — on
//! every OS the exact-comparison test below runs (darwin/linux; Windows x64 f32
//! divergence risk from #990's own review took it off that platform).
//!
//! Exact comparison on purpose. The decision margin measured over this corpus is
//! `min |p - 0.5| = 9.16e-4`, so there is no float drift small enough to justify
//! a tolerance and large enough to be legitimate: anything that moves a span here
//! moved a frame across the threshold, and that is exactly what must not happen.

mod common;

#[cfg(not(windows))]
use std::path::PathBuf;

use kesha_engine::audio::load_audio;
#[cfg(not(windows))]
use kesha_engine::vad::{VadConfig, VadDetector};

/// Spans in seconds, as produced by `detect_segments` at `VadConfig::default()`.
/// Regenerate only with a recorded reason: a diff here is a changed contract.
#[cfg(not(windows))]
const GOLDEN: &[(&str, &[(f32, f32)])] = &[
    (
        "01-ne-nuzhno-slat-soobshcheniya.ogg",
        &[(0.226, 4.766), (4.898, 7.2134376)],
    ),
    (
        "02-prover-vse-svoi-konfigi.ogg",
        &[(0.578, 4.03), (4.482, 7.102)],
    ),
    (
        "03-ty-dobavil-sebe-v-pamyat.ogg",
        &[(0.226, 2.206), (3.138, 6.142)],
    ),
    (
        "04-pokazhi-ego-yuzerneim.ogg",
        &[(0.418, 1.726), (1.794, 4.693375)],
    ),
    ("05-vynesi-eshche-sekret-ot-kloda.ogg", &[(0.354, 4.414)]),
    (
        "06-kakie-eshche-telegram-yuzery.ogg",
        &[(0.386, 1.534), (1.634, 4.062)],
    ),
    ("07-to-chto-nakhoditsya-v-papke.ogg", &[(0.258, 3.518)]),
    ("08-uznai-vtorogo-yuzera.ogg", &[(0.226, 2.494)]),
    ("09-ustanovi-poka-klod-kod.ogg", &[(0.386, 2.302)]),
    ("10-zakomit-izmeneniya-v-git.ogg", &[(0.418, 2.213375)]),
    ("01-check-email.ogg", &[(0.002, 4.1734376)]),
    ("02-meeting-rescheduled.ogg", &[(0.0, 4.5334377)]),
    ("03-review-pull-request.ogg", &[(0.002, 4.1134377)]),
    ("04-deploy-staging.ogg", &[(0.002, 4.6534376)]),
    ("05-database-migration.ogg", &[(0.0, 4.9334373)]),
    ("06-code-review-session.ogg", &[(0.002, 4.5334377)]),
    ("07-run-test-suite.ogg", &[(0.002, 4.1534376)]),
    ("08-update-documentation.ogg", &[(0.002, 4.8534374)]),
    ("09-refactor-notifications.ogg", &[(0.002, 4.8534374)]),
    ("10-load-balancer-config.ogg", &[(0.0, 5.2534375)]),
];

#[cfg(not(windows))]
fn fixtures() -> Vec<PathBuf> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root");
    let mut paths: Vec<PathBuf> = ["tests/fixtures/benchmark", "tests/fixtures/benchmark-en"]
        .iter()
        .flat_map(|d| std::fs::read_dir(root.join(d)).expect("fixture dir"))
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "ogg"))
        .collect();
    paths.sort();
    paths
}

/// Pulled out so a test can pin the `assert_not_lfs_pointer` call site itself, not just the
/// standalone function — deleting the call from the loop below left this test green (#990 round 2).
fn decode_fixture(path: &std::path::Path) -> (String, Vec<f32>) {
    let name = path
        .file_name()
        .expect("fixture name")
        .to_string_lossy()
        .into_owned();
    common::assert_not_lfs_pointer(path);
    let audio = load_audio(path).unwrap_or_else(|e| panic!("decode {name}: {e}"));
    (name, audio)
}

#[test]
fn decode_fixture_rejects_a_pointer_stub() {
    let dir =
        std::env::temp_dir().join(format!("kesha-vad-spans-lfs-guard-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let pointer = dir.join("pointer.ogg");
    std::fs::write(
        &pointer,
        b"version https://git-lfs.github.com/spec/v1\noid sha256:deadbeef\nsize 12345\n",
    )
    .expect("write pointer stub");
    let outcome = std::panic::catch_unwind(|| decode_fixture(&pointer));
    std::fs::remove_dir_all(&dir).ok();
    let message = outcome.as_ref().err().map(|e| {
        e.downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "<non-string panic payload>".to_string())
    });
    assert!(
        message.as_deref().is_some_and(|m| m.contains("LFS pointer stub")),
        "expected the actionable LFS-pointer message before decoding, got: {message:?} — a decode-failure panic from a deleted guard call would satisfy is_err() too"
    );
}

#[cfg(not(windows))]
fn render(rows: &[(String, Vec<(f32, f32)>)]) -> String {
    let mut out = String::from("const GOLDEN: &[(&str, &[(f32, f32)])] = &[\n");
    for (name, spans) in rows {
        let body: Vec<String> = spans
            .iter()
            .map(|(s, e)| format!("({s:?}, {e:?})"))
            .collect();
        out.push_str(&format!("    (\"{name}\", &[{}]),\n", body.join(", ")));
    }
    out.push_str("];\n");
    out
}

// Goldens are macOS-ARM-exact f32; #990 round-1 review flagged this Windows x64 divergence risk, so darwin/linux only.
#[cfg(not(windows))]
#[test]
fn detect_segments_reproduces_the_committed_spans() {
    let Some(model) = common::vad_model_or_skip("detect_segments_reproduces_the_committed_spans")
    else {
        return;
    };
    let mut vad = VadDetector::load(&model).expect("load Silero VAD");

    let mut actual: Vec<(String, Vec<(f32, f32)>)> = Vec::new();
    for path in fixtures() {
        let (name, audio) = decode_fixture(&path);
        let spans = vad
            .detect_segments(&audio, VadConfig::default())
            .unwrap_or_else(|e| panic!("detect_segments {name}: {e}"));
        actual.push((name, spans));
    }

    assert!(
        !actual.is_empty(),
        "no benchmark fixtures found — run `git lfs pull`"
    );

    let expected: Vec<(String, Vec<(f32, f32)>)> = GOLDEN
        .iter()
        .map(|(n, s)| ((*n).to_string(), s.to_vec()))
        .collect();

    if actual != expected {
        panic!(
            "VAD spans differ from the committed goldens.\n\
             Spans are a user-visible contract (--timestamps / --json / diarization); \
             a diff here means the change moved them.\n\nactual:\n{}",
            render(&actual)
        );
    }
}
