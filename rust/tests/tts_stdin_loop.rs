//! Integration tests for `kesha-engine say --stdin-loop` (issue #213).
//!
//! Frame format:
//!
//! ```text
//! <status:u8><id:u32 LE><len:u32 LE><payload:[u8; len]>
//! ```
//!
//! The interesting tests need real Kokoro model files and run when
//! `KOKORO_MODEL` + `KOKORO_VOICE` env vars are set (matching the convention
//! in `tts_smoke.rs`). The protocol-only tests (malformed JSON, empty text,
//! framing layout) run unconditionally.

#![cfg(feature = "tts")]

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::Duration;

const STATUS_OK: u8 = 0;
const STATUS_ERR: u8 = 1;

/// A response frame parsed off the engine's stdout.
struct Frame {
    status: u8,
    id: u32,
    payload: Vec<u8>,
}

/// Read exactly `n` bytes or return an Err on early EOF.
fn read_exact(r: &mut impl Read, n: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

fn read_frame(r: &mut impl Read) -> std::io::Result<Frame> {
    let header = read_exact(r, 9)?;
    let status = header[0];
    let id = u32::from_le_bytes([header[1], header[2], header[3], header[4]]);
    let len = u32::from_le_bytes([header[5], header[6], header[7], header[8]]) as usize;
    let payload = read_exact(r, len)?;
    Ok(Frame {
        status,
        id,
        payload,
    })
}

struct LoopChild {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl LoopChild {
    fn spawn() -> Self {
        let bin = env!("CARGO_BIN_EXE_kesha-engine");
        let mut child = Command::new(bin)
            .args(["say", "--stdin-loop"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn engine");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        LoopChild {
            child,
            stdin,
            stdout,
        }
    }

    fn send(&mut self, json_line: &str) {
        self.stdin.write_all(json_line.as_bytes()).unwrap();
        self.stdin.write_all(b"\n").unwrap();
        self.stdin.flush().unwrap();
    }

    fn recv(&mut self) -> Frame {
        read_frame(&mut self.stdout).expect("read frame")
    }

    fn close(mut self) {
        // Dropping stdin closes the pipe; the loop sees EOF and exits 0.
        drop(self.stdin);
        // Poll for up to 2 s for clean exit before killing.
        for _ in 0..20 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------
// Protocol-only tests (no model required)
// ---------------------------------------------------------------------------

#[test]
fn malformed_json_returns_err_frame_with_zero_id() {
    let mut c = LoopChild::spawn();
    c.send("{not json");
    let f = c.recv();
    assert_eq!(f.status, STATUS_ERR, "expected err status for bad json");
    assert_eq!(f.id, 0, "pre-parse errors should carry id=0");
    let msg = String::from_utf8_lossy(&f.payload);
    assert!(
        msg.starts_with("json:"),
        "error payload should be tagged 'json:': {msg}"
    );
    c.close();
}

#[test]
fn empty_text_returns_err_frame_with_request_id() {
    let mut c = LoopChild::spawn();
    c.send(r#"{"id": 42, "text": "", "voice": "en-am_michael"}"#);
    let f = c.recv();
    assert_eq!(f.status, STATUS_ERR);
    assert_eq!(f.id, 42, "post-parse errors should echo the request id");
    let msg = String::from_utf8_lossy(&f.payload);
    assert!(msg.contains("text is empty"), "unexpected error: {msg}");
    c.close();
}

#[test]
fn unknown_voice_returns_err_frame_with_request_id() {
    let mut c = LoopChild::spawn();
    c.send(r#"{"id": 9, "text": "hi", "voice": "zz-not-a-voice"}"#);
    let f = c.recv();
    assert_eq!(f.status, STATUS_ERR);
    assert_eq!(f.id, 9);
    c.close();
}

// ---------------------------------------------------------------------------
// Real synthesis (gated on env vars set by run_smoke_tests / smoke harness)
// ---------------------------------------------------------------------------

fn kokoro_paths() -> Option<(String, String)> {
    match (std::env::var("KOKORO_MODEL"), std::env::var("KOKORO_VOICE")) {
        (Ok(m), Ok(v)) => Some((m, v)),
        _ => None,
    }
}

#[test]
fn loop_synthesises_kokoro_and_caches_session() {
    // The CLI test pinning `--model` / `--voice-file` is the testing override
    // path. The loop-mode JSON request takes voice-by-name only, so this test
    // must use the default cache layout. If the test runner hasn't populated
    // KESHA_CACHE_DIR with Kokoro models (`kesha install --tts`), skip.
    let cache_has_kokoro = kokoro_paths()
        .map(|(model, _)| std::path::Path::new(&model).exists())
        .unwrap_or(false);
    if !cache_has_kokoro {
        eprintln!("skipping: KOKORO_MODEL not set / file missing");
        return;
    }

    let mut c = LoopChild::spawn();
    let req1 = r#"{"id": 1, "text": "Hello", "voice": "en-am_michael", "format": "wav"}"#;
    let req2 = r#"{"id": 2, "text": "World", "voice": "en-am_michael", "format": "wav"}"#;

    let t0 = std::time::Instant::now();
    c.send(req1);
    let f1 = c.recv();
    let cold = t0.elapsed();

    let t1 = std::time::Instant::now();
    c.send(req2);
    let f2 = c.recv();
    let warm = t1.elapsed();

    assert_eq!(f1.status, STATUS_OK, "first request failed");
    assert_eq!(f1.id, 1);
    assert_eq!(&f1.payload[..4], b"RIFF", "not a WAV");

    assert_eq!(f2.status, STATUS_OK, "second request failed");
    assert_eq!(f2.id, 2);
    assert_eq!(&f2.payload[..4], b"RIFF");

    // The whole point of the loop: warm < cold by a clear margin. We don't
    // pin a ratio (CI noise) but warm should at least be measurably faster
    // than cold. A 25% headroom catches accidental no-cache regressions.
    assert!(
        warm < cold.mul_f32(0.75),
        "warm ({warm:?}) should be noticeably faster than cold ({cold:?}) — cache may not be working"
    );
    c.close();
}
