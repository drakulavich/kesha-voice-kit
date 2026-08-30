//! Behavioral tests for `rust/ci/download-vad.sh` — the manifest pact in `src/models.rs` only checks the URL/hash literals, not that hashing or verification actually works (#990).

use std::fs;
use std::path::Path;
use std::process::Command;

fn script_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("ci/download-vad.sh")
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

    let inner = format!(
        "source '{}'; sha_of '{}'",
        script_path().display(),
        target.to_string_lossy().replace('\'', "'\\''")
    );
    let output = Command::new("bash")
        .arg("-c")
        .arg(&inner)
        .output()
        .expect("run sha_of via bash");

    fs::remove_dir_all(&dir).ok();

    assert!(
        output.status.success(),
        "sourcing download-vad.sh and calling sha_of failed: {}",
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
