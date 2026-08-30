//! End-to-end regression tests for audio-container error handling on
//! `transcribe`. Lives outside `rust/src/transcribe/` so it can use the
//! checked-in fixtures under `rust/tests/fixtures/` without pulling that
//! path into the production module's `use` graph.
//!
//! The `ensure_audio_track` tests exercise `transcribe_with_options`'s early
//! bail (v1.17.0). The garbage-input test verifies the "unsupported audio
//! format" arm; the m4a-fixture test verifies the `isomp4` symphonia feature
//! is wired so AAC-in-M4A probes succeed.

use kesha_engine::audio;
use kesha_engine::errors::{code_of, ErrorCode};

fn fixture(name: &str) -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
        .to_str()
        .unwrap()
        .to_string()
}

// #935: an unreadable container is the user's input, not an Engine fault, so
// ingest must code it `E_BAD_AUDIO` rather than falling back to `E_INTERNAL`.
// This drives the real `open_format` path (site rust/src/audio.rs:78) with a
// non-container. `code_of` returned `Internal` before the fix.
#[test]
fn unsupported_container_is_coded_bad_audio_not_internal() {
    let tmp = tempfile::Builder::new()
        .prefix("kesha-badaudio-code-")
        .suffix(".bin")
        .tempfile()
        .unwrap();
    std::fs::write(tmp.path(), b"not an audio file at all").unwrap();
    let path = tmp.path().to_str().unwrap();

    let err = audio::ensure_audio_track(path).expect_err("non-container must fail");
    assert_eq!(
        code_of(&err),
        ErrorCode::BadAudio,
        "unreadable input must be E_BAD_AUDIO, got {:?}: {err:#}",
        code_of(&err)
    );

    // The same path reached through the decode entry point must agree.
    let err = audio::load_audio(std::path::Path::new(path))
        .expect_err("decoding a non-container must fail");
    assert_eq!(code_of(&err), ErrorCode::BadAudio, "{err:#}");
}

// #935 site :85 — a container the Engine demuxes but that carries no audio
// track (video-only MP4) is the user's input. `code_of` returned `Internal`
// before the fix. Fixture: `ffmpeg -f lavfi -i color=black:s=16x16:d=0.1
// -c:v mpeg4 -an video-only.mp4` (895 bytes, no audio stream).
#[test]
fn video_only_container_is_coded_bad_audio() {
    let path = fixture("video-only.mp4");
    let err = audio::ensure_audio_track(&path).expect_err("a video-only container must fail");
    assert_eq!(code_of(&err), ErrorCode::BadAudio, "{err:#}");
    assert!(
        format!("{err:#}").contains("no supported audio tracks"),
        "expected the no-tracks arm, got: {err:#}"
    );
}

// #935 site :108 — a container the Engine demuxes carrying a codec it has no
// decoder for (ALAC in M4A: symphonia recognises the codec but ships no ALAC
// decoder) is the user's input. `code_of` returned `Internal` before the fix.
// Fixture: `ffmpeg -f lavfi -i sine=440:d=0.1:r=16000 -c:a alac alac.m4a`.
#[test]
fn undecodable_codec_is_coded_bad_audio() {
    let path = fixture("alac.m4a");
    // The container opens (the track is real), so the failure surfaces at decode.
    audio::ensure_audio_track(&path).expect("ALAC container opens; the track is valid");
    let err =
        audio::load_audio(std::path::Path::new(&path)).expect_err("an undecodable codec must fail");
    assert_eq!(code_of(&err), ErrorCode::BadAudio, "{err:#}");
    assert!(
        format!("{err:#}").contains("unsupported codec"),
        "expected the codec arm, got: {err:#}"
    );
}

#[test]
fn ensure_audio_track_bails_on_unsupported_container() {
    let tmp = tempfile::Builder::new()
        .prefix("kesha-bad-container-")
        .suffix(".bin")
        .tempfile()
        .unwrap();
    std::fs::write(tmp.path(), b"not an audio file at all").unwrap();

    let err = audio::ensure_audio_track(tmp.path().to_str().unwrap())
        .expect_err("should bail on unsupported container");
    let msg = format!("{err:#}");
    assert!(
        msg.contains("unsupported audio format"),
        "expected clear format error, got: {msg}"
    );
}

#[test]
fn ensure_audio_track_accepts_isomp4_aac_fixture() {
    // Regression catcher: if someone drops `isomp4` from the symphonia
    // feature list in rust/Cargo.toml again, opening this m4a will fail
    // with "unsupported audio format" and this test goes red. The
    // fixture is ~900 bytes of silence (0.5 s @ 16 kHz mono AAC) so the
    // repo footprint is negligible.
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("silence.m4a");
    assert!(fixture.exists(), "fixture missing: {}", fixture.display());

    audio::ensure_audio_track(fixture.to_str().unwrap())
        .expect("isomp4 feature should let symphonia open the m4a container");

    // `probe_duration_seconds` should also work on the same fixture.
    // ffmpeg's anullsrc tends to leave `n_frames` populated for AAC-LC,
    // so we expect Some. If the encoder ever changes and starts emitting
    // a streaming-style m4a without n_frames, the assertion can flip to
    // `is_ok()` (the test still proves isomp4 is enabled).
    let dur = audio::probe_duration_seconds(fixture.to_str().unwrap())
        .expect("probe_duration_seconds should succeed on the m4a fixture");
    assert!(
        dur.is_some(),
        "expected Some duration for the silence.m4a fixture, got None"
    );
}

#[test]
fn measure_duration_recovers_what_the_probe_cannot_report() {
    // #767: an Ogg whose last page carries no end-of-stream flag declares no
    // frame count, so the probe reports unknown — the shape of every Russian
    // benchmark fixture. Regenerate it with `fixtures/regen-tone-no-eos.py`.
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("tone-no-eos.ogg");
    let path = fixture.to_str().unwrap();

    assert_eq!(
        audio::probe_duration_seconds(path).expect("probe should open the container"),
        None,
        "fixture no longer probes as unknown duration, so it stops covering #767"
    );

    let measured =
        audio::measure_duration_seconds(path).expect("decode-and-measure should succeed");
    // The 0.5 s source decodes to 0.5135 s: libopus pads the tail to a whole frame.
    assert!(
        (0.48..0.55).contains(&measured),
        "expected the fixture's 0.51 s, got {measured}"
    );
}

#[test]
fn measure_duration_reports_a_usable_error_for_a_non_container() {
    let tmp = tempfile::Builder::new()
        .prefix("kesha-measure-bad-")
        .suffix(".ogg")
        .tempfile()
        .unwrap();
    std::fs::write(tmp.path(), b"not an audio file at all").unwrap();

    let err = audio::measure_duration_seconds(tmp.path().to_str().unwrap())
        .expect_err("measuring a non-container must fail");
    assert!(
        format!("{err:#}").contains("unsupported audio format"),
        "expected clear format error, got: {err:#}"
    );
}

#[test]
fn ensure_audio_track_accepts_uppercase_extension() {
    // F21: `build_hint` lowercases the extension before handing it to
    // symphonia. Symphonia's matching is case-insensitive today, but
    // normalising at the boundary is a defensive zero-cost guard. This
    // test pins the normalisation: copy the m4a fixture to a tempfile
    // with `.M4A` (uppercase) and verify probe still succeeds. If a
    // future refactor drops the lowercase pass and symphonia tightens
    // its matching upstream, this test goes red.
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("silence.m4a");
    let tmp = tempfile::Builder::new()
        .prefix("kesha-uppercase-ext-")
        .suffix(".M4A")
        .tempfile()
        .expect("create tempfile with uppercase extension");
    std::fs::copy(&fixture, tmp.path()).expect("copy fixture into uppercase tempfile");

    audio::ensure_audio_track(tmp.path().to_str().unwrap())
        .expect("uppercase .M4A extension should still probe successfully");
}
