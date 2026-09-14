//! CLI-level assertions that a failure reaches the caller as one coded error event.
mod common;
use std::process::Command;

fn engine_bin() -> String {
    std::env::var("CARGO_BIN_EXE_kesha-engine")
        .unwrap_or_else(|_| "target/release/kesha-engine".to_string())
}

#[test]
fn a_missing_input_is_reported_as_one_error_event() {
    let out = Command::new(engine_bin())
        .args(["transcribe", "/nonexistent/audio.wav"])
        .output()
        .expect("spawn engine");
    assert_eq!(out.status.code(), Some(1));
    assert!(
        out.stdout.is_empty(),
        "protocol-v4 D1: stdout carries only the payload"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    let lines: Vec<&str> = stderr.lines().collect();
    assert_eq!(lines.len(), 1, "exactly one event, got: {stderr}");
    let v: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(v["kind"], "error");
    assert_eq!(v["code"], "E_INPUT_NOT_FOUND");
}

// Exploratory S2-4: the ceiling is a documented product limit, not an engine fault, so its
// refusal must read as the caller's argument. Checked before any model is required, so the
// empty cache below cannot turn it into E_MODEL_MISSING.
#[test]
fn no_vad_over_the_single_pass_ceiling_is_an_invalid_argument_before_any_model_is_needed() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("marathon.wav");
    common::write_pcm16_wav(&wav, 16_000, 25 * 60 * 16_000, 250_000);
    let out = Command::new(engine_bin())
        .args(["transcribe", "--no-vad"])
        .arg(&wav)
        .env("KESHA_CACHE_DIR", dir.path().join("cache"))
        .output()
        .expect("spawn engine");
    assert_eq!(out.status.code(), Some(1));
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_INVALID_ARG", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("single-pass limit"),
        "{v}"
    );
}

// Exploratory S2-2: a WAV declaring sample rate 0 made symphonia panic inside the probe, so
// the raw panic line and the RUST_BACKTRACE hint reached the user and the code was E_INTERNAL.
// The header is the user's input: one E_BAD_AUDIO event naming the file, nothing else.
#[test]
fn a_wav_declaring_sample_rate_zero_is_bad_audio_with_no_panic_text() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("rate-zero.wav");
    common::write_pcm16_wav(&wav, 0, 1_600, 3_200);
    let out = Command::new(engine_bin())
        .arg("transcribe")
        .arg(&wav)
        .env("KESHA_CACHE_DIR", dir.path().join("cache"))
        .output()
        .expect("spawn engine");
    assert_eq!(
        out.status.code(),
        Some(1),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v = common::sole_error_event(&out);
    assert_eq!(v["code"], "E_BAD_AUDIO", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("rate-zero.wav"),
        "{v}"
    );
}

/// A producer that never closes the pipe: `say` must answer once the text limit is passed, not wait for EOF.
#[test]
fn say_stops_reading_an_open_stdin_pipe_once_the_text_limit_is_passed() {
    use std::io::Write as _;
    let dir = tempfile::tempdir().expect("tempdir");
    let out = dir.path().join("never.wav");
    let mut child = Command::new(engine_bin())
        .args(["say", "--out", out.to_str().unwrap()])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn engine");
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let _ = stdin.write_all(&vec![b'x'; 5000 * 4 + 4096]);
    let _ = stdin.flush();
    let started = std::time::Instant::now();
    let out = loop {
        if let Some(status) = child.try_wait().expect("poll") {
            let mut stderr = String::new();
            std::io::Read::read_to_string(child.stderr.as_mut().unwrap(), &mut stderr).unwrap();
            break (status, stderr);
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "say waited on the open pipe"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    drop(stdin);
    assert_eq!(out.0.code(), Some(5), "{}", out.1);
    let v: serde_json::Value =
        serde_json::from_str(out.1.lines().next().unwrap_or("")).expect("one event");
    assert_eq!(v["code"], "E_TEXT_TOO_LONG", "{v}");
}

fn detect_text_lang_on_stdin(text: &[u8]) -> std::process::Output {
    use std::io::Write as _;
    let mut child = Command::new(engine_bin())
        .arg("detect-text-lang")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn engine");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(text)
        .expect("write stdin");
    child.wait_with_output().expect("engine exits")
}

// T1-1: no user text may be an argv element, so the positional is optional and stdin is the source.
#[test]
fn detect_text_lang_reads_the_text_from_stdin_when_no_positional_is_given() {
    let blank = detect_text_lang_on_stdin(b"   \n\t  ");
    let v = common::sole_error_event(&blank);
    let message = v["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("detect-text-lang requires non-empty text"),
        "the whitespace came from stdin, not from a missing argument: {v}"
    );
    assert!(
        !message.contains("required arguments were not provided"),
        "the positional must be optional: {v}"
    );

    let given = detect_text_lang_on_stdin("Привет мир как дела".as_bytes());
    let stderr = String::from_utf8_lossy(&given.stderr);
    assert!(
        !stderr.contains("requires non-empty text"),
        "text on stdin must reach the detector: {stderr}"
    );
}
