fn main() {
    // The `coreml`, `system_kokoro`, and `system_diarize` features all pull in
    // fluidaudio-rs, which links against the macOS Swift runtime
    // (libswift_Concurrency.dylib and friends). Without an explicit rpath the
    // dynamic linker fails at startup with
    // `Library not loaded: @rpath/libswift_Concurrency.dylib`. /usr/lib/swift is
    // the standard location on macOS 13+. CI also sets MACOSX_DEPLOYMENT_TARGET=14.0
    // to elide the dep, but this rpath keeps local `system_kokoro`/`system_diarize`
    // builds runnable without that env var.
    #[cfg(any(
        feature = "coreml",
        feature = "system_kokoro",
        feature = "system_diarize"
    ))]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    // `system_tts` (#141): compile the AVSpeechSynthesizer helper on macOS.
    // Writes the sidecar binary to $OUT_DIR/say-avspeech. Silently no-op on
    // other targets so `--features system_tts` works in cross-platform builds.
    #[cfg(all(feature = "system_tts", target_os = "macos"))]
    build_avspeech_helper();

    // detect-text-lang fast-path sidecar: compile the NLLanguageRecognizer
    // helper on macOS. Writes the sidecar binary to $OUT_DIR/kesha-textlang.
    // Opt-in via `system_text_lang` so minimal macOS environments without
    // Xcode CLT can still `cargo build` (falls back to legacy `swift -e`
    // path in text_lang.rs). Silently no-op on Linux/Windows.
    #[cfg(all(feature = "system_text_lang", target_os = "macos"))]
    build_text_lang_helper();
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
    //
    // KNOWN LIMITATION: $OUT_DIR is ephemeral and machine-specific. After
    // `cargo clean` or when kesha-engine is moved off this machine (installed,
    // distributed, or zipped in a release), this baked-in path becomes stale.
    // Part 3 of #141 replaces this with "look up a sibling `say-avspeech`
    // next to the current executable" for deployed binaries, keeping this
    // path as the fallback for `cargo run` / `cargo test`.
    println!(
        "cargo:rustc-env=KESHA_AVSPEECH_HELPER={}",
        out_bin.display()
    );
}

#[cfg(all(feature = "system_text_lang", target_os = "macos"))]
fn build_text_lang_helper() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest_dir.join("swift/kesha-textlang.swift");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let out_bin = out_dir.join("kesha-textlang");

    println!("cargo:rerun-if-changed={}", src.display());

    let status = Command::new("swiftc")
        .arg("-O")
        .arg("-o")
        .arg(&out_bin)
        .arg(&src)
        .status()
        .expect(
            "swiftc not found — install Xcode command-line tools (required for text-lang sidecar)",
        );
    assert!(
        status.success(),
        "swiftc failed to build kesha-textlang from {}",
        src.display()
    );

    // Expose the path to runtime code via env!("KESHA_TEXTLANG_HELPER").
    // Same KNOWN LIMITATION as say-avspeech: $OUT_DIR is ephemeral, so the
    // runtime resolver in `text_lang::helper_path` tries sibling-of-exe first
    // and falls back to this baked path only for `cargo run` / `cargo test`.
    println!(
        "cargo:rustc-env=KESHA_TEXTLANG_HELPER={}",
        out_bin.display()
    );
}
