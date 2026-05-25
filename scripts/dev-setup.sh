#!/usr/bin/env bash
# Contributor bootstrap for kesha-voice-kit.
#
# Philosophy (matches the repo's no-surprise-install rules in CLAUDE.md): this
# script AUTO-RUNS only safe, project-local steps (bun install, bun link, git
# lfs pull, cargo install cargo-nextest). It NEVER runs `brew`/`sudo apt-get`
# on your behalf — for missing system packages it prints the exact command for
# YOUR platform and leaves it to you. Idempotent: safe to re-run.
#
# Usage: make dev-setup   (or: bash scripts/dev-setup.sh)
set -uo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
todo() { printf '  \033[33mTODO\033[0m %s\n' "$1"; }
run()  { printf '  \033[36m->\033[0m   %s\n' "$1"; }

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux)  OS=linux ;;
  *)      OS=other ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }

missing_system=0

# --- Required toolchains (guide only; installing these is the user's call) ---
bold "Toolchains"

if have bun; then
  ok "bun ($(bun --version))"
else
  todo "bun not found — install from https://bun.sh (curl -fsSL https://bun.sh/install | bash)"
  missing_system=1
fi

if have cargo; then
  ok "cargo ($(cargo --version | awk '{print $2}'))"
else
  todo "Rust not found — install rustup: https://rustup.rs (curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)"
  missing_system=1
fi

# --- System libraries the Rust build needs (guide only) ---
bold "System libraries (Rust build deps)"

# protoc: vosk-tts-rs / prost-build need a protobuf compiler.
if have protoc; then
  ok "protoc ($(protoc --version | awk '{print $2}'))"
else
  case "$OS" in
    macos) todo "protoc missing — brew install protobuf" ;;
    linux) todo "protoc missing — sudo apt-get install -y protobuf-compiler" ;;
    *)     todo "protoc missing — install a protobuf compiler for your OS" ;;
  esac
  missing_system=1
fi

# libopus + pkg-config: audiopus_sys / opusic-sys (OGG/Opus output).
if have pkg-config && pkg-config --exists opus 2>/dev/null; then
  ok "libopus (via pkg-config)"
else
  case "$OS" in
    macos) todo "libopus/pkg-config missing — brew install opus pkg-config" ;;
    linux) todo "libopus/pkg-config missing — sudo apt-get install -y libopus-dev pkg-config" ;;
    *)     todo "libopus + pkg-config missing — install them for your OS" ;;
  esac
  missing_system=1
fi

# libclang: bindgen (espeakng-sys clang-runtime etc.) needs it on Linux.
if [ "$OS" = linux ]; then
  if have llvm-config; then
    ok "libclang (llvm-config present)"
    run "export LIBCLANG_PATH=\"\$(llvm-config --libdir)\"   # add to your shell rc"
  else
    todo "libclang missing — sudo apt-get install -y libclang-dev llvm-dev, then export LIBCLANG_PATH=\$(llvm-config --libdir)"
    missing_system=1
  fi
fi

# git-lfs: fixtures/assets are LFS-managed.
if have git-lfs || git lfs version >/dev/null 2>&1; then
  ok "git-lfs"
else
  case "$OS" in
    macos) todo "git-lfs missing — brew install git-lfs && git lfs install" ;;
    linux) todo "git-lfs missing — sudo apt-get install -y git-lfs && git lfs install" ;;
    *)     todo "git-lfs missing — install it for your OS, then: git lfs install" ;;
  esac
  missing_system=1
fi

# --- Safe project-local steps (auto-run) ---
bold "Project setup (auto-run)"

if have bun; then
  run "bun install"
  if bun install >/dev/null 2>&1; then ok "dependencies installed"; else todo "bun install failed — run it manually to see the error"; fi
  run "bun link  (registers the local kesha CLI)"
  if bun link >/dev/null 2>&1; then ok "kesha CLI linked"; else todo "bun link failed — run it manually"; fi
else
  todo "skipped bun install / bun link (bun not on PATH)"
fi

if have git-lfs || git lfs version >/dev/null 2>&1; then
  run "git lfs pull  (materialize fixtures/assets)"
  if git lfs pull >/dev/null 2>&1; then ok "LFS objects pulled"; else todo "git lfs pull failed — run it manually"; fi
fi

if have cargo; then
  if cargo nextest --version >/dev/null 2>&1; then
    ok "cargo-nextest already installed"
  else
    run "cargo install cargo-nextest --locked  (the required test runner)"
    if cargo install cargo-nextest --locked >/dev/null 2>&1; then
      ok "cargo-nextest installed"
    else
      todo "cargo install cargo-nextest --locked failed — run it manually"
    fi
  fi
fi

# --- macOS runtime env hint ---
if [ "$OS" = macos ]; then
  bold "macOS env (add to your shell rc for local Rust runs)"
  run "export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib"
  run "export RUSTFLAGS=\"-L /opt/homebrew/lib\""
  run "export LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib"
fi

# --- Footnotes ---
bold "Optional"
run "Nix users: nix develop  (flake.nix; aarch64-darwin / x86_64-linux)"
run "jj + Git LFS: see the 'JJ + GIT LFS WORKAROUND' section in CLAUDE.md"
run "Models are install-only: kesha install  (+ --tts / --vad / --diarize)"

echo
if [ "$missing_system" -eq 0 ]; then
  bold "All toolchains + system libraries present. Try: make cli-fast"
else
  bold "Install the TODO items above, then re-run: make dev-setup"
fi
# Always exit 0 — this is a guide, not a gate.
exit 0
