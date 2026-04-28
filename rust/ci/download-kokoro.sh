#!/usr/bin/env bash
# Download Kokoro + Vosk-TTS-Russian ONNX models for CI tts_e2e tests.
# Called by rust-test.yml; cache warms on subsequent runs.
#
# Kokoro files land directly in $DEST (legacy layout — the test env vars
# KOKORO_MODEL / KOKORO_VOICE take direct paths). Vosk files land under
# $DEST/models/vosk-ru/, matching `models::vosk_ru_model_dir()` so the
# runtime loader finds them when KESHA_CACHE_DIR=$DEST is set by the
# test runner.
set -euo pipefail

DEST="${1:?usage: download-kokoro.sh <dest_dir>}"
mkdir -p "$DEST"

if [[ ! -f "$DEST/model.onnx" ]]; then
  echo "Downloading Kokoro model.onnx (kokoro-onnx official release)..."
  # Mirrors rust/src/models.rs::kokoro_manifest URL — see #207 for why we
  # switched off the HF onnx-community variant.
  curl -fL -o "$DEST/model.onnx" \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
fi

if [[ ! -f "$DEST/am_michael.bin" ]]; then
  # Default voice is am_michael per CLAUDE.md "DEFAULT TTS VOICES MUST BE MALE".
  # rust-test.yml's run-cargo-test.sh gates Kokoro e2e tests on this filename.
  echo "Downloading Kokoro am_michael.bin..."
  curl -fL -o "$DEST/am_michael.bin" \
    https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_michael.bin
fi

# Vosk-TTS Russian (replaces old engine as of #213). Multi-speaker model,
# 5 files, ~935 MB total. SHA-256 pinned in rust/src/models.rs::vosk_ru_manifest().
# Downloads run in parallel to keep cold-cache CI times bounded.
VOSK_DIR="$DEST/models/vosk-ru"
mkdir -p "$VOSK_DIR/bert"
VOSK_BASE="https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main"
download_if_missing() {
  local rel="$1"
  if [[ ! -f "$VOSK_DIR/$rel" ]]; then
    echo "Downloading Vosk $rel..."
    curl -fL -o "$VOSK_DIR/$rel" "$VOSK_BASE/$rel"
  fi
}
download_if_missing model.onnx &
download_if_missing dictionary &
download_if_missing config.json &
download_if_missing bert/model.onnx &
download_if_missing bert/vocab.txt &
wait

ls -lh "$DEST"
ls -lh "$VOSK_DIR"
ls -lh "$VOSK_DIR/bert"
