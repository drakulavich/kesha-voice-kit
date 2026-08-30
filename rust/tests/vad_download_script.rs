//! Behavioral test for `rust/ci/download-vad.sh`'s SHA-256 verification: a corrupted or tampered
//! download must be rejected and never staged. The manifest pact in `src/models.rs` only proves
//! the script's URL/hash literals match the pin — it says nothing about whether the script's
//! `verify` gate actually runs, which is the gap review found for #990.

use std::fs;
use std::path::Path;
use std::process::Command;

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

    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("ci/download-vad.sh");
    let path_var = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let output = Command::new("bash")
        .arg(&script)
        .arg(&cache_dir)
        .env("PATH", path_var)
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
