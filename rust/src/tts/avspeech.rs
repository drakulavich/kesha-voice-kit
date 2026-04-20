//! AVSpeechSynthesizer backend (#141) — macOS-only, behind the `system_tts` feature.
//!
//! Shells out to a Swift sidecar (`swift/say-avspeech.swift`, compiled by
//! `build.rs` into `$OUT_DIR/say-avspeech`). The Rust side pipes UTF-8 text on
//! stdin, passes the voice identifier as argv\[1\], and reads a complete WAV
//! (mono IEEE-float @ 22050 Hz) from stdout. Stderr is surfaced in the error
//! message when synthesis fails.
//!
//! Wired into `tts::say()` dispatch via `EngineChoice::AVSpeech` and selected
//! by the `macos-*` voice-id prefix in `tts::voices::resolve_voice`.

#![cfg(all(feature = "system_tts", target_os = "macos"))]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Path to the sidecar `say-avspeech` binary.
///
/// Resolution order:
/// 1. A sibling `say-avspeech` file next to the currently-running executable.
///    This is the release-distribution path — `kesha install` downloads both
///    `kesha-engine-darwin-arm64` and `say-avspeech-darwin-arm64` into the
///    same cache directory.
/// 2. The build-time `$OUT_DIR/say-avspeech` baked in by `build.rs`. Used by
///    `cargo run` / `cargo test`, where the sidecar lives in the target dir
///    but not next to the engine executable.
pub fn helper_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let sibling = parent.join("say-avspeech");
            if sibling.exists() {
                return sibling;
            }
        }
    }
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

/// Enumerate the installed macOS voices via the sidecar's `--list-voices` mode.
///
/// Returns prefixed voice IDs (`macos-<identifier>`) ready to merge into the
/// `say --list-voices` output. Returns an empty Vec on any failure — callers
/// treat macos-* as a best-effort extension: if the helper is missing or the
/// enumeration fails, they should still show Kokoro/Piper voices.
pub fn list_voices(helper: Option<&Path>) -> Vec<String> {
    let bin = helper.map(PathBuf::from).unwrap_or_else(helper_path);

    let Ok(output) = Command::new(&bin)
        .arg("--list-voices")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        // Lines are `identifier|language|name` (see swift/say-avspeech.swift).
        // We only surface the identifier; callers can look up language/name
        // via AVSpeechSynthesisVoice if they want richer metadata.
        .filter_map(|line| line.split('|').next())
        .filter(|id| !id.is_empty())
        .map(|id| format!("macos-{id}"))
        .collect()
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

    #[test]
    fn list_voices_parses_helper_output() {
        let tmp = TempDir::new().unwrap();
        let helper = fake_helper(
            &tmp,
            r#"printf 'com.apple.voice.compact.en-US.Samantha|en-US|Samantha\ncom.apple.voice.compact.ru-RU.Milena|ru-RU|Milena\n'"#,
        );
        let voices = list_voices(Some(&helper));
        assert_eq!(
            voices,
            vec![
                "macos-com.apple.voice.compact.en-US.Samantha".to_string(),
                "macos-com.apple.voice.compact.ru-RU.Milena".to_string(),
            ]
        );
    }

    #[test]
    fn list_voices_empty_on_helper_failure() {
        let tmp = TempDir::new().unwrap();
        let helper = fake_helper(&tmp, "exit 1");
        assert!(list_voices(Some(&helper)).is_empty());
    }

    #[test]
    fn list_voices_skips_empty_lines() {
        let tmp = TempDir::new().unwrap();
        let helper = fake_helper(
            &tmp,
            r#"printf '\ncom.apple.voice.compact.en-US.Samantha|en-US|Samantha\n\n'"#,
        );
        let voices = list_voices(Some(&helper));
        assert_eq!(
            voices,
            vec!["macos-com.apple.voice.compact.en-US.Samantha".to_string()]
        );
    }
}
