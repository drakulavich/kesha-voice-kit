fn main() {
    // The `coreml` feature pulls in fluidaudio-rs, which links against the
    // macOS Swift runtime (libswift_Concurrency.dylib and friends). Without
    // an explicit rpath the dynamic linker fails at startup with
    // `Library not loaded: @rpath/libswift_Concurrency.dylib`. /usr/lib/swift
    // is the standard location on macOS 13+.
    #[cfg(feature = "coreml")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    // `system_tts` (#141): compile the AVSpeechSynthesizer helper on macOS.
    // Writes the sidecar binary to $OUT_DIR/say-avspeech. Silently no-op on
    // other targets so `--features system_tts` works in cross-platform builds.
    #[cfg(all(feature = "system_tts", target_os = "macos"))]
    build_avspeech_helper();
}

#[cfg(all(feature = "system_tts", target_os = "macos"))]
fn build_avspeech_helper() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest_dir.join("swift/say-avspeech.swift");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let out_bin = out_dir.join("say-avspeech");

    println!("cargo:rerun-if-changed={}", src.display());

    let status = Command::new("swiftc")
        .arg("-O")
        .arg("-o")
        .arg(&out_bin)
        .arg(&src)
        .status()
        .expect(
            "swiftc not found — install Xcode command-line tools or disable --features system_tts",
        );
    assert!(
        status.success(),
        "swiftc failed to build say-avspeech from {}",
        src.display()
    );

    // Expose the path to runtime code via env!("KESHA_AVSPEECH_HELPER").
    println!(
        "cargo:rustc-env=KESHA_AVSPEECH_HELPER={}",
        out_bin.display()
    );
}
