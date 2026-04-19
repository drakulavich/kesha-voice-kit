//! AVSpeechSynthesizer backend (#141) — macOS-only, behind the `system_tts` feature.
//!
//! Shells out to a Swift sidecar (`swift/say-avspeech.swift`, compiled by
//! `build.rs` into `$OUT_DIR/say-avspeech`). The Rust side pipes UTF-8 text on
//! stdin, passes the voice identifier as argv\[1\], and reads a complete WAV
//! (mono IEEE-float @ 22050 Hz) from stdout. Stderr is surfaced in the error
//! message when synthesis fails.
//!
//! This module is infrastructure only for this PR — callers (voice routing,
//! `say()` dispatch) land in a follow-up. See issue #141.

#![cfg(all(feature = "system_tts", target_os = "macos"))]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Path to the sidecar `say-avspeech` binary, baked in at build time by `build.rs`.
pub fn helper_path() -> PathBuf {
    PathBuf::from(env!("KESHA_AVSPEECH_HELPER"))
}

/// Synthesize `text` with the macOS voice identified by `voice_id`.
///
/// `voice_id` is forwarded verbatim to `AVSpeechSynthesisVoice(identifier:)` and
/// falls back to `AVSpeechSynthesisVoice(language:)` inside the helper. Accepts
/// either a full identifier (`com.apple.voice.compact.en-US.Samantha`) or a
/// language code (`en-US`, `ru-RU`).
///
/// Returns complete WAV bytes. `helper` defaults to [`helper_path()`] when `None`
/// — tests inject a fake helper to verify the subprocess contract without needing
/// the real Swift binary.
pub fn synthesize(text: &str, voice_id: &str, helper: Option<&Path>) -> anyhow::Result<Vec<u8>> {
    if text.is_empty() {
        anyhow::bail!("avspeech: text is empty");
    }
    let bin = helper.map(PathBuf::from).unwrap_or_else(helper_path);

    let mut child = Command::new(&bin)
        .arg(voice_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("spawn {}: {e}", bin.display()))?;

    child
        .stdin
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("avspeech: stdin unavailable"))?
        .write_all(text.as_bytes())?;
    drop(child.stdin.take());

    let output = child.wait_with_output()?;
    if !output.status.success() {
        anyhow::bail!(
            "avspeech helper exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fake_helper(tmp: &TempDir, script: &str) -> PathBuf {
        let path = tmp.path().join("fake-helper.sh");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "{script}").unwrap();
        drop(f);
        // chmod +x
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[test]
    fn empty_text_errors() {
        let err = synthesize("", "en-US", Some(Path::new("/bin/true")))
            .unwrap_err()
            .to_string();
        assert!(err.contains("empty"), "msg: {err}");
    }

    #[test]
    fn helper_stdout_is_returned_verbatim() {
        let tmp = TempDir::new().unwrap();
        let helper = fake_helper(&tmp, r#"cat >/dev/null; printf 'RIFFmock'"#);
        let bytes = synthesize("hello", "en-US", Some(&helper)).unwrap();
        assert_eq!(&bytes, b"RIFFmock");
    }

    #[test]
    fn helper_nonzero_exit_surfaces_stderr() {
        let tmp = TempDir::new().unwrap();
        let helper = fake_helper(&tmp, r#"echo 'voice not found: xyz' >&2; exit 2"#);
        let err = synthesize("hello", "xyz", Some(&helper))
            .unwrap_err()
            .to_string();
        assert!(err.contains("voice not found"), "msg: {err}");
        assert!(err.contains("exited"), "msg: {err}");
    }

    #[test]
    fn text_is_piped_on_stdin() {
        let tmp = TempDir::new().unwrap();
        // `cat` echoes stdin to stdout, so the result should be exactly the input text.
        let helper = fake_helper(&tmp, "cat");
        let bytes = synthesize("Hello, kesha!", "en-US", Some(&helper)).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "Hello, kesha!");
    }
}
