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

if [[ -f "$KOKORO_CACHE/model.onnx" && -f "$KOKORO_CACHE/am_michael.bin" ]]; then
  export KOKORO_MODEL="$KOKORO_CACHE/model.onnx"
  export KOKORO_VOICE="$KOKORO_CACHE/am_michael.bin"
  echo "Running with real Kokoro models from $KOKORO_CACHE"
else
  echo "Kokoro cache empty — gated tests will skip"
fi

# Vosk-ru lives under $KOKORO_CACHE/models/vosk-ru/... matching the
# runtime `models::vosk_ru_model_dir()` layout (see download-kokoro.sh).
if [[ -f "$KOKORO_CACHE/models/vosk-ru/model.onnx" && -f "$KOKORO_CACHE/models/vosk-ru/bert/model.onnx" ]]; then
  export KESHA_CACHE_DIR="$KOKORO_CACHE"
  echo "KESHA_CACHE_DIR=$KESHA_CACHE_DIR (Vosk gated tests enabled)"
fi

# CharsiuG2P for tts_multilang_audio (es/fr/it/pt). The runtime-layout Kokoro
# model + multilang voices are staged by download-kokoro.sh; the test also gates
# on CHARSIU_ONNX pointing at the byt5-tiny dir (KESHA_CACHE_DIR set above lets
# kokoro_cache_dir_or_skip resolve the voices).
if [[ -f "$KOKORO_CACHE/models/g2p/byt5-tiny/encoder_model.onnx" ]]; then
  export CHARSIU_ONNX="$KOKORO_CACHE/models/g2p/byt5-tiny"
  echo "CHARSIU_ONNX=$CHARSIU_ONNX (multilingual TTS gated tests enabled)"
fi

cargo nextest run --profile ci
