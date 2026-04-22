#!/usr/bin/env bash
# Run `cargo test` with Kokoro env vars + KESHA_CACHE_DIR pointing at the
# workflow's warm model cache. Skips the real-inference tests if the cache
# is empty.
set -euo pipefail

KOKORO_CACHE="${1:?usage: run-cargo-test.sh <kokoro_cache> <runner_os>}"
RUNNER_OS="${2:?}"

cd rust

case "$RUNNER_OS" in
  macOS|Linux|Windows) ;;
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

# G2P + Piper live under $KOKORO_CACHE/models/... matching the
# runtime `models::cache_dir()` layout (see download-kokoro.sh).
if [[ -d "$KOKORO_CACHE/models/g2p/byt5-tiny" ]]; then
  export KESHA_CACHE_DIR="$KOKORO_CACHE"
  export PIPER_MODEL="$KOKORO_CACHE/models/piper-ru/ru_RU-denis-medium.onnx"
  export PIPER_CONFIG="$KOKORO_CACHE/models/piper-ru/ru_RU-denis-medium.onnx.json"
  echo "KESHA_CACHE_DIR=$KESHA_CACHE_DIR (G2P + Piper gated tests enabled)"
fi

cargo test --verbose
