//! AVSpeechSynthesizer backend (#141) — macOS-only, behind the `system_tts` feature.
//!
//! Shells out to a Swift sidecar (`swift/say-avspeech.swift`, compiled by
//! `build.rs` into `$OUT_DIR/say-avspeech`). The Rust side pipes UTF-8 text on
//! stdin, passes the voice identifier as argv\[1\], and reads a complete WAV
//! (mono IEEE-float at the voice's own rate — 22050 Hz for the legacy voices,
//! 16000 Hz for the Eloquence set) from stdout. Stderr is surfaced in the error
//! message when synthesis fails.

#![cfg(all(feature = "system_tts", target_os = "macos"))]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::coded_bail;
use crate::errors::{CodedContext, ErrorCode};
use crate::process_tree::ChildGuard;

/// Path to the sidecar `say-avspeech` binary.
///
/// Prefers a sibling next to the running executable (release layout, where
/// `kesha install` co-locates both binaries); falls back to the build-time
/// `$OUT_DIR/say-avspeech` baked in by `build.rs` for `cargo run`/`cargo test`.
pub fn helper_path() -> PathBuf {
    let sibling = sibling_helper_path();
    if sibling.exists() {
        return sibling;
    }
    PathBuf::from(env!("KESHA_AVSPEECH_HELPER"))
}

/// Where a user's sidecar must sit; the build-time `$OUT_DIR` fallback names a machine nobody has (T2-4).
fn sibling_helper_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("say-avspeech")))
        .unwrap_or_else(|| PathBuf::from("say-avspeech"))
}

/// The sidecar's contract: exit 2 with this prefix on stderr is the one failure that is the caller's.
const VOICE_NOT_FOUND: &str = "voice not found:";

fn sidecar_hint() -> String {
    format!(
        "reinstall with `kesha install`; the sidecar must sit beside kesha-engine at {}",
        sibling_helper_path().display()
    )
}

/// Synthesize `text` with the macOS voice identified by `voice_id`.
///
/// `voice_id` is forwarded to `AVSpeechSynthesisVoice(identifier:)` with a
/// fallback to `AVSpeechSynthesisVoice(language:)` inside the helper — accepts
/// a full identifier or a language code (`en-US`, `ru-RU`).
///
/// `speed` (0.5–2.0, 1.0 = default) is forwarded as `--rate`; the sidecar maps
/// it onto the `AVSpeechUtterance.rate` 0.0–1.0 scale (#546).
///
/// `helper` defaults to [`helper_path()`] when `None`; tests inject a fake helper.
pub fn synthesize(
    text: &str,
    voice_id: &str,
    speed: f32,
    helper: Option<&Path>,
) -> anyhow::Result<Vec<u8>> {
    if text.is_empty() {
        anyhow::bail!("avspeech: text is empty");
    }
    let bin = helper.map(PathBuf::from).unwrap_or_else(helper_path);

    let mut cmd = Command::new(&bin);
    cmd.arg(voice_id)
        .arg("--rate")
        .arg(speed.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| {
            anyhow::anyhow!(
                "cannot start the say-avspeech sidecar: {e}. {}",
                sidecar_hint()
            )
        })
        .coded(ErrorCode::SidecarMissing)?;
    let mut child = ChildGuard::new(child);

    child
        .stdin_mut()
        .ok_or_else(|| anyhow::anyhow!("avspeech: stdin unavailable"))?
        .write_all(text.as_bytes())?;
    child.close_stdin();

    let output = child.wait_with_output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        if output.status.code() == Some(2) && stderr.starts_with(VOICE_NOT_FOUND) {
            coded_bail!(
                ErrorCode::VoiceUnknown,
                "macOS voice '{voice_id}' is not installed on this Mac. Download it in \
                 System Settings > Accessibility > Spoken Content, or pick one from \
                 `kesha say --list-voices`"
            );
        }
        coded_bail!(
            ErrorCode::SidecarMissing,
            "avspeech helper exited {}: {stderr}. {}",
            output.status,
            sidecar_hint()
        );
    }
    Ok(output.stdout)
}

/// Returns `macos-<identifier>` voice IDs for `say --list-voices`.
/// Returns an empty Vec on any failure — macos-* voices are best-effort; missing
/// helper must not suppress Kokoro/Piper voices.
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
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[test]
    fn empty_text_errors() {
        let err = synthesize("", "en-US", 1.0, Some(Path::new("/bin/true")))
            .unwrap_err()
            .to_string();
        assert!(err.contains("empty"), "msg: {err}");
    }

    #[test]
    fn helper_stdout_is_returned_verbatim() {
        let tmp = TempDir::new().unwrap();
        let helper = fake_helper(&tmp, r#"cat >/dev/null; printf 'RIFFmock'"#);
        let bytes = synthesize("hello", "en-US", 1.0, Some(&helper)).unwrap();
        assert_eq!(&bytes, b"RIFFmock");
    }

    #[test]
    fn an_unknown_voice_is_voice_unknown_with_the_system_settings_hint() {
        let tmp = TempDir::new().unwrap();
        let helper = fake_helper(&tmp, r#"echo 'voice not found: xyz' >&2; exit 2"#);
        let err = synthesize("hello", "xyz", 1.0, Some(&helper)).unwrap_err();
        assert_eq!(crate::errors::code_of(&err), ErrorCode::VoiceUnknown);
        let msg = format!("{err:#}");
        assert!(msg.contains("xyz"), "msg: {msg}");
        assert!(msg.contains("System Settings"), "msg: {msg}");
        assert!(msg.contains("--list-voices"), "msg: {msg}");
    }

    #[test]
    fn any_other_helper_failure_is_sidecar_missing_naming_the_sibling_path() {
        let tmp = TempDir::new().unwrap();
        let cases = [
            fake_helper(&tmp, r#"echo 'boom' >&2; exit 1"#),
            tmp.path().join("absent-helper"),
        ];
        for helper in cases {
            let err = synthesize("hello", "en-US", 1.0, Some(&helper)).unwrap_err();
            assert_eq!(
                crate::errors::code_of(&err),
                ErrorCode::SidecarMissing,
                "{}",
                helper.display()
            );
            let msg = format!("{err:#}");
            assert!(msg.contains("kesha install"), "msg: {msg}");
            assert!(
                msg.contains(&sibling_helper_path().display().to_string()),
                "the message names where the sidecar must sit: {msg}"
            );
            assert!(
                !msg.contains(env!("KESHA_AVSPEECH_HELPER")),
                "the build-time helper path must never reach a user: {msg}"
            );
        }
    }

    #[test]
    fn text_is_piped_on_stdin() {
        let tmp = TempDir::new().unwrap();
        // `cat` echoes stdin to stdout, so the result should be exactly the input text.
        let helper = fake_helper(&tmp, "cat");
        let bytes = synthesize("Hello, kesha!", "en-US", 1.0, Some(&helper)).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "Hello, kesha!");
    }

    /// The sidecar must receive `--rate <value>` as argv[2] and argv[3].
    /// A fake helper that echoes all arguments to stdout lets us assert the
    /// exact contract without requiring the real Swift binary (#546).
    #[test]
    fn rate_is_forwarded_as_cli_arg() {
        let tmp = TempDir::new().unwrap();
        let helper = fake_helper(&tmp, r#"cat >/dev/null; echo "$*""#);
        let out = synthesize("hello", "en-US", 1.5, Some(&helper)).unwrap();
        let args_line = String::from_utf8(out).unwrap();
        assert!(
            args_line.contains("--rate"),
            "sidecar must receive --rate flag; got: {args_line:?}"
        );
        assert!(
            args_line.contains("1.5"),
            "sidecar must receive the rate value; got: {args_line:?}"
        );
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
