#!/usr/bin/env bash
# Run `cargo test` with platform-specific env vars for espeak-ng linking
# and Kokoro-model paths. Skips the real-inference tests if the cache is empty.
set -euo pipefail

KOKORO_CACHE="${1:?usage: run-cargo-test.sh <kokoro_cache> <runner_os>}"
RUNNER_OS="${2:?}"

cd rust

case "$RUNNER_OS" in
  macOS)
    export LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib
    export RUSTFLAGS="-L /opt/homebrew/lib"
    export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib
    ;;
  Linux)
    # apt-installed libespeak-ng is discovered via pkg-config / default lib paths
    :
    ;;
  Windows)
    # LIB / PATH / LIBCLANG_PATH are set in the workflow step before this
    # script runs — choco install espeak-ng lands at C:\Program Files\eSpeak NG.
    :
    ;;
  *)
    echo "unsupported runner: $RUNNER_OS" >&2
    exit 1
    ;;
esac

if [[ -f "$KOKORO_CACHE/model.onnx" && -f "$KOKORO_CACHE/af_heart.bin" ]]; then
  export KOKORO_MODEL="$KOKORO_CACHE/model.onnx"
  export KOKORO_VOICE="$KOKORO_CACHE/af_heart.bin"
  echo "Running with real Kokoro models from $KOKORO_CACHE"
else
  echo "Kokoro cache empty — gated tests will skip"
fi

cargo test --verbose
