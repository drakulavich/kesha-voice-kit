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

if [[ ! -f "$DEST/af_heart.bin" ]]; then
  echo "Downloading Kokoro af_heart.bin..."
  curl -fL -o "$DEST/af_heart.bin" \
    https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin
fi

# Vosk-TTS Russian (replaces old engine as of #213). Multi-speaker model,
# 6 files, ~935 MB total. SHA-256 pinned in rust/src/models.rs::vosk_ru_manifest().
VOSK_DIR="$DEST/models/vosk-ru"
mkdir -p "$VOSK_DIR/bert"
VOSK_BASE="https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main"
for f in model.onnx dictionary config.json README.md; do
  if [[ ! -f "$VOSK_DIR/$f" ]]; then
    echo "Downloading Vosk $f..."
    curl -fL -o "$VOSK_DIR/$f" "$VOSK_BASE/$f"
  fi
done
for f in model.onnx vocab.txt; do
  if [[ ! -f "$VOSK_DIR/bert/$f" ]]; then
    echo "Downloading Vosk bert/$f..."
    curl -fL -o "$VOSK_DIR/bert/$f" "$VOSK_BASE/bert/$f"
  fi
done

ls -lh "$DEST"
ls -lh "$VOSK_DIR"
ls -lh "$VOSK_DIR/bert"
