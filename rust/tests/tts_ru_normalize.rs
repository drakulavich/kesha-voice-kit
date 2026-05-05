//! Issue #232 — Russian acronym auto-expansion + <say-as> integration.
//!
//! Asserts byte-length deltas through the full Vosk synth pipeline so a
//! regression in the new tts::ru layer (or in how SayOptions threads
//! `expand_abbrev`) shows up as a hard test failure rather than a
//! subjective audio change.
//!
//! Session strategy: most tests drive the engine via `--stdin-loop` so a
//! single Vosk model load (~1-2 s) is shared across requests. One test
//! keeps the cold `tts::say()` path for regression coverage of the
//! direct-call stack.

#![cfg(feature = "tts")]

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use kesha_engine::tts::{self, EngineChoice, OutputFormat, SayOptions};

// =============================================================================
// Shared helpers
// =============================================================================

/// Return the vosk-ru model dir if the required runtime files are present;
/// otherwise return None so callers can skip gracefully.
///
/// Strategy: use KESHA_CACHE_DIR when set (matches CI / local dev fixture
/// layout), otherwise fall back to the default `~/.cache/kesha`. This mirrors
/// what `models::vosk_ru_model_dir()` does in production — no staging copy
/// needed because these tests are read-only.
fn vosk_model_dir_or_skip() -> Option<PathBuf> {
    let base = if let Ok(dir) = std::env::var("KESHA_CACHE_DIR") {
        PathBuf::from(dir)
    } else {
        // Same logic as models::cache_dir() for the default path.
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(home).join(".cache/kesha")
    };

    let model_dir = base.join("models/vosk-ru");

    // Mirror models::is_vosk_ru_cached() — keep gates aligned.
    if model_dir.join("model.onnx").exists()
        && model_dir.join("dictionary").exists()
        && model_dir.join("bert/model.onnx").exists()
    {
        Some(model_dir)
    } else {
        None
    }
}

/// Cold synthesis via `tts::say()` — kept for direct-call regression coverage.
fn synth_cold(text: &str, ssml: bool, expand_abbrev: bool, model_dir: &PathBuf) -> Vec<u8> {
    tts::say(SayOptions {
        text,
        lang: "ru",
        engine: EngineChoice::Vosk {
            model_dir,
            // speaker_id 4 = ru-vosk-m02 (male), per voices.rs ru-vosk-* mapping
            speaker_id: 4,
            speed: 1.0,
        },
        ssml,
        format: OutputFormat::Wav,
        expand_abbrev,
    })
    .expect("synth ok")
}

// =============================================================================
// stdin-loop engine wrapper
// =============================================================================

/// Thin wrapper around a `kesha-engine say --stdin-loop` subprocess.
///
/// One `LoopEngine` holds a single Vosk model load, amortising the ~1-2 s
/// cold-start across multiple `synth` calls.
struct LoopEngine {
    child: std::process::Child,
    /// Wrapped in `Option` so `Drop` can `take()` and explicitly drop the
    /// write end of the stdin pipe BEFORE `child.wait()` — otherwise the
    /// engine sits in `read_line` waiting for EOF that never arrives, and
    /// the test deadlocks at end-of-scope.
    stdin: Option<std::process::ChildStdin>,
    stdout: std::process::ChildStdout,
}

impl LoopEngine {
    /// Spawn the engine subprocess. Returns `None` when the vosk-ru models
    /// are not installed (same skip gate as the cold-path tests).
    fn spawn() -> Option<Self> {
        vosk_model_dir_or_skip()?;
        let bin = env!("CARGO_BIN_EXE_kesha-engine");
        let mut child = Command::new(bin)
            .args(["say", "--voice", "ru-vosk-m02", "--stdin-loop"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn kesha-engine --stdin-loop");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = child.stdout.take().expect("child stdout");
        Some(Self {
            child,
            stdin: Some(stdin),
            stdout,
        })
    }

    /// Synthesise `text` and return the raw audio bytes (WAV).
    ///
    /// Wire protocol (from `say_loop.rs`):
    /// - request:  `<JSON>\n`
    /// - response: `<status:u8><id:u32 LE><len:u32 LE><payload:[u8; len]>`
    ///   - status 0 = ok (WAV bytes), status 1 = error (UTF-8 message)
    fn synth(&mut self, text: &str, ssml: bool, expand_abbrev: bool) -> Vec<u8> {
        let req = serde_json::json!({
            "id": 1,
            "text": text,
            "voice": "ru-vosk-m02",
            "format": "wav",
            "ssml": ssml,
            "expand_abbrev": expand_abbrev,
        });
        let mut line = req.to_string();
        line.push('\n');
        let stdin = self
            .stdin
            .as_mut()
            .expect("stdin held while LoopEngine is alive");
        stdin.write_all(line.as_bytes()).expect("write request");
        stdin.flush().expect("flush request");

        // --- read response header (9 bytes) ---
        let mut header = [0u8; 9];
        self.stdout
            .read_exact(&mut header)
            .expect("read response header");
        let status = header[0];
        let len = u32::from_le_bytes([header[5], header[6], header[7], header[8]]) as usize;

        // --- read payload ---
        let mut payload = vec![0u8; len];
        self.stdout
            .read_exact(&mut payload)
            .expect("read response payload");

        if status != 0 {
            panic!(
                "engine error: {}",
                std::str::from_utf8(&payload).unwrap_or("<non-utf8>")
            );
        }
        payload
    }
}

impl Drop for LoopEngine {
    fn drop(&mut self) {
        // Close the write end of stdin BEFORE waiting on the child — engine
        // sees EOF on its read_line loop and exits cleanly. If we leave the
        // ChildStdin alive (the natural field-drop order would close it
        // AFTER this Drop body returns), `child.wait()` deadlocks.
        drop(self.stdin.take());
        let _ = self.child.wait();
    }
}

// =============================================================================
// Tests
// =============================================================================

/// Auto-expanding "ФСБ" (3 all-consonant letters → "эф эс бэ")
/// must produce noticeably more audio than passing "ФСБ" straight to Vosk
/// without expansion. Threshold: ≥1.3× by byte count.
///
/// This test exercises the cold `tts::say()` path directly — kept as
/// regression coverage for the direct-call stack (no subprocess).
///
/// Note: ВОЗ is no longer used here because the vowel-cluster rule (#232)
/// passes it through as a word (alternating C-V-C reads fine as "воз").
/// ФСБ has no vowels → always spells.
#[test]
fn auto_expand_plain_fsb_is_longer_than_noexpand() {
    let model_dir = match vosk_model_dir_or_skip() {
        Some(d) => d,
        None => {
            eprintln!(
                "skipping auto_expand_plain_fsb_is_longer_than_noexpand: vosk-ru models not found"
            );
            return;
        }
    };

    let expanded = synth_cold(
        "ФСБ", /*ssml=*/ false, /*expand_abbrev=*/ true, &model_dir,
    );
    let plain = synth_cold(
        "ФСБ", /*ssml=*/ false, /*expand_abbrev=*/ false, &model_dir,
    );

    let ratio = expanded.len() as f64 / plain.len() as f64;
    assert!(
        ratio > 1.3,
        "expanded={} plain={} ratio={:.2} (expected >1.3×)",
        expanded.len(),
        plain.len(),
        ratio,
    );
}

/// Warm-session batch: two ratio checks under a single Vosk model load via
/// `kesha-engine say --stdin-loop`. Spawns one `LoopEngine` and runs:
///
/// 1. `<say-as interpret-as="characters">ФСБ</say-as>` must spell out
///    letters identically to auto-expand: within ±10% by byte length.
/// 2. With `expand_abbrev=false`, uppercase "ВОЗ" and lowercase "воз" must
///    produce audio within ±30% (they read the same phonetically to Vosk).
#[test]
fn warm_session_say_as_and_baseline_checks() {
    let mut eng = match LoopEngine::spawn() {
        Some(e) => e,
        None => {
            eprintln!("skipping warm_session_say_as_and_baseline_checks: vosk-ru models not found");
            return;
        }
    };

    // --- check 1: <say-as characters> parity with auto-expand ---
    let auto_fsb = eng.synth("ФСБ", false, true);
    let ssml_fsb = eng.synth(
        r#"<speak><say-as interpret-as="characters">ФСБ</say-as></speak>"#,
        true,
        false, // <say-as> wins regardless of expand_abbrev flag
    );
    let ratio1 = ssml_fsb.len() as f64 / auto_fsb.len() as f64;
    assert!(
        (0.9..=1.1).contains(&ratio1),
        "say-as/auto-expand parity: auto_fsb={} ssml_fsb={} ratio={:.2} (expected 0.9..=1.1)",
        auto_fsb.len(),
        ssml_fsb.len(),
        ratio1,
    );

    // --- check 2: no-expand ВОЗ vs воз baseline ---
    let upper_voz = eng.synth("ВОЗ", false, false);
    let lower_voz = eng.synth("воз", false, false);
    let ratio2 = upper_voz.len() as f64 / lower_voz.len() as f64;
    assert!(
        (0.7..=1.3).contains(&ratio2),
        "ВОЗ/воз baseline: upper={} lower={} ratio={:.2} (expected 0.7..=1.3)",
        upper_voz.len(),
        lower_voz.len(),
        ratio2,
    );
}
