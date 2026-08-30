//! Behavioral tests for `rust/ci/download-vad.sh` — the manifest pact in `src/models/manifest.rs` only checks the URL/hash literals, not that hashing or verification actually works (#990).

use std::fs;
use std::path::Path;
use std::process::Command;

fn script_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("ci/download-vad.sh")
}

/// Plain `Command::new("bash")` resolves to `C:\Windows\System32\bash.exe` on
/// Windows CI runners before it ever reaches Git for Windows' real bash — that
/// path is the WSL launcher stub, which (with no distro installed) exits
/// non-zero and writes its error straight to the console rather than the
/// piped stderr `Command::output` captures, so the failure looked like a
/// silent crash. `BASH` overrides for a caller that knows better; otherwise
/// prefer Git for Windows' known install locations, then fall back to a PATH
/// scan that skips anything under `system32`.
fn resolve_bash() -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("BASH") {
        let p = std::path::PathBuf::from(path);
        if p.is_file() {
            return Some(p);
        }
    }

    if cfg!(windows) {
        for candidate in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            let p = std::path::PathBuf::from(candidate);
            if p.is_file() {
                return Some(p);
            }
        }
    }

    let path_var = std::env::var_os("PATH")?;
    let bash_name = if cfg!(windows) { "bash.exe" } else { "bash" };
    std::env::split_paths(&path_var).find_map(|dir| {
        if cfg!(windows) && dir.to_string_lossy().to_lowercase().contains("system32") {
            return None;
        }
        let candidate = dir.join(bash_name);
        candidate.is_file().then_some(candidate)
    })
}

/// Cross-platform (unlike the curl-stub test below): sources the script and calls `sha_of`
/// directly on a path containing a literal backslash, reproducing the byte shape of Git-Bash's
/// mixed-separator Windows paths (`D:\a\...\.vad-cache`) that broke Windows CI before #990's fix
/// — the class of regression round-2 review found this file's `#[cfg(unix)]` test couldn't cover.
#[test]
fn sha_of_hashes_a_backslash_bearing_path_to_a_bare_hex_digest() {
    let dir = std::env::temp_dir().join(format!("kesha-vad-shaof-{}", std::process::id()));
    fs::create_dir_all(&dir).expect("temp dir");
    let target = dir.join("a\\b.onnx");
    fs::create_dir_all(target.parent().expect("fixture parent")).expect("fixture parent dir");
    fs::write(&target, b"hello vad").expect("write fixture");

    let Some(bash) = resolve_bash() else {
        eprintln!(
            "no usable bash found (Windows' System32\\bash.exe WSL stub is deliberately skipped) — \
             skipping sha_of_hashes_a_backslash_bearing_path_to_a_bare_hex_digest"
        );
        fs::remove_dir_all(&dir).ok();
        return;
    };

    let inner = format!(
        "source '{}'; sha_of '{}'",
        script_path().display(),
        target.to_string_lossy().replace('\'', "'\\''")
    );
    let output = Command::new(&bash)
        .arg("-c")
        .arg(&inner)
        .output()
        .unwrap_or_else(|e| panic!("failed to spawn {}: {e}", bash.display()));

    fs::remove_dir_all(&dir).ok();

    assert!(
        output.status.success(),
        "sourcing download-vad.sh and calling sha_of via {} failed: status={:?} stdout={:?} stderr={:?}",
        bash.display(),
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
    assert_eq!(
        hash.len(),
        64,
        "sha_of must print a bare 64-hex-char hash, got {hash:?} — a leading backslash means the Windows escaping bug is back"
    );
    assert!(
        hash.chars().all(|c| c.is_ascii_hexdigit()),
        "sha_of output {hash:?} contains non-hex characters"
    );
}

#[cfg(unix)]
#[test]
fn download_vad_rejects_a_corrupted_download_and_never_stages_it() {
    let tmp = std::env::temp_dir().join(format!("kesha-vad-dl-test-{}", std::process::id()));
    let bin_dir = tmp.join("bin");
    let cache_dir = tmp.join("cache");
    fs::create_dir_all(&bin_dir).expect("temp bin dir");
    fs::create_dir_all(&cache_dir).expect("temp cache dir");

    // A fake `curl` ahead of the real one on PATH: whatever URL is requested, it writes garbage
    // to the `-o` target instead of the real model, simulating a corrupted/tampered download.
    let fake_curl = bin_dir.join("curl");
    fs::write(
        &fake_curl,
        "#!/usr/bin/env bash\nfor ((i=1;i<=$#;i++)); do [[ \"${!i}\" == \"-o\" ]] && { j=$((i+1)); printf 'not the real model' > \"${!j}\"; exit 0; }; done\nexit 1\n",
    )
    .expect("write fake curl");
    let mut perms = fs::metadata(&fake_curl)
        .expect("fake curl metadata")
        .permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
    fs::set_permissions(&fake_curl, perms).expect("chmod fake curl");

    let path_var = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let output = Command::new("bash")
        .arg(script_path())
        .arg(&cache_dir)
        .env("PATH", path_var)
        .env("DOWNLOAD_VAD_ATTEMPTS", "1")
        .env("DOWNLOAD_VAD_RETRY_SECONDS", "0")
        .output()
        .expect("run download-vad.sh");

    let staged = cache_dir.join("models/silero-vad/silero_vad.onnx");
    let staged_exists = staged.exists();
    fs::remove_dir_all(&tmp).ok();

    assert!(
        !output.status.success(),
        "download-vad.sh must fail on a hash mismatch, not exit 0 — stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !staged_exists,
        "a corrupted download must never be staged at {}",
        staged.display()
    );
}
