{
  description = "Kesha Voice Kit - fast multilingual voice toolkit with Bun CLI and Rust engine";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    naersk = {
      url = "github:nix-community/naersk";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, flake-utils, naersk, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
        };

        naersk' = pkgs.callPackage naersk {};

        inherit (pkgs) lib;

        # Platform detection
        isLinux = lib.hasSuffix "linux" system;
        isDarwin = lib.hasSuffix "darwin" system;
        isAarch64 = lib.hasPrefix "aarch64" system;

        # Rust features per platform
        rustFeatures = if isDarwin && isAarch64
          then "coreml,tts,system_tts"
          else "onnx,tts";

        # Build-time dependencies (tools needed to compile)
        nativeBuildInputs = with pkgs; [
          protobuf
          llvmPackages.libclang
          pkg-config
          cmake
          makeWrapper
        ];

        # Runtime dependencies (libraries to link against)
        buildInputs = with pkgs; [
          openssl
          opus
        ] ++ lib.optionals isLinux (with pkgs; [
          clang
          llvmPackages.llvm
          onnxruntime
          protobuf
          abseil-cpp
        ]);

        darwinBuildInputs = with pkgs; [
        ];

        # Environment variables for build - passed directly to mkDerivation
        buildEnv = {
          LIBCLANG_PATH = if isDarwin then "/Library/Developer/CommandLineTools/usr/lib" else "${pkgs.llvmPackages.libclang.lib}/lib";
          PROTOC = "${pkgs.protobuf}/bin/protoc";
          OPENSSL_LIB_DIR = "${pkgs.openssl.out}/lib";
          OPENSSL_INCLUDE_DIR = "${pkgs.openssl.dev}/include";
          SYS_OPUS = "1";
          CMAKE_POLICY_VERSION_MINIMUM = "3.5";
        };

        # Linux-specific env vars for onnxruntime
        linuxEnv = lib.optionalAttrs isLinux {
          ORT_STRATEGY = "system";
          ORT_LIB_LOCATION = "${pkgs.onnxruntime}/lib";
          ORT_PREFER_DYNAMIC_LINK = "1";
          RUSTFLAGS = "-L native=${pkgs.onnxruntime}/lib -L native=${pkgs.protobuf}/lib -L native=${pkgs.abseil-cpp}/lib -l onnxruntime -l protobuf -l absl_base -l absl_log_internal_check_op -l absl_log_internal_conditions -l absl_log_internal_message -l absl_log_internal_nullguard -l absl_examine_stack -l absl_log_internal_format -l absl_log_internal_structured_proto -l absl_log_internal_log_sink_set -l absl_log_sink -l absl_log_entry -l absl_log_internal_proto -l absl_flags_internal -l absl_flags_marshalling -l absl_flags_reflection -l absl_flags_config -l absl_flags_program_name -l absl_flags_private_handle_accessor -l absl_statusor -l absl_log_initialize -l absl_die_if_null";
        };

        # Patch ort-sys build script to skip link verification  
        patchOrtSys = ''
          find . -path "*/ort-sys*/build.rs" -exec sed -i 's/panic!(.*ort-sys could not link.*)/eprintln!("Skipping ort-sys link check in Nix"); return;/' {} \; 2>/dev/null || true
          # Debug: show what we patched
          find . -path "*/ort-sys*/build.rs" -exec grep -n "Skipping" {} \; 2>/dev/null || echo "No patch applied"
        '';

        # Naersk build for kesha-engine
        kesha-engine = naersk'.buildPackage {
          src = ./rust;
          root = ./rust;
          inherit (buildEnv) LIBCLANG_PATH PROTOC OPENSSL_LIB_DIR OPENSSL_INCLUDE_DIR SYS_OPUS CMAKE_POLICY_VERSION_MINIMUM;
          inherit (linuxEnv) ORT_STRATEGY ORT_LIB_LOCATION ORT_PREFER_DYNAMIC_LINK;
          inherit nativeBuildInputs buildInputs;
          cargoBuildOptions = old: old ++ [ "--features" rustFeatures "--no-default-features" ];
          cargoTestOptions = old: old ++ [ "--features" rustFeatures "--no-default-features" ];
          overrideMain = old: {
            preBuild = patchOrtSys;
          };
        };

      in
      {
        packages = {
          kesha-engine = kesha-engine;
          default = kesha-engine;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = buildInputs ++ (with pkgs; [
            rustc
            cargo
            rustfmt
            clippy
            cargo-make
            bun
            gnumake
          ]);
          shellHook = ''
            echo "✓ Kesha Voice Kit development environment"
            echo "  - Rust: $(rustc --version 2>/dev/null || echo 'not found')"
            echo "  - Bun: $(bun --version 2>/dev/null || echo 'not found')"
            echo "  - Protoc: $(protoc --version 2>/dev/null || echo 'not found')"
            echo "  - Features: ${rustFeatures}"
            ${lib.optionalString isLinux ''
              export ORT_STRATEGY="system"
              export ORT_LIB_LOCATION="${pkgs.onnxruntime.out}/lib"
            ''}
          '';
        };
      }
    );
}
