#!/usr/bin/env bash
# Download Kokoro + CharsiuG2P ONNX models for CI tts_e2e tests.
# Called by rust-test.yml; cache warms on subsequent runs.
#
# Kokoro files land directly in $DEST (legacy layout — the test env vars
# KOKORO_MODEL / KOKORO_VOICE take direct paths). G2P files land under
# $DEST/models/g2p/byt5-tiny/, matching `models::cache_dir()` so the
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

G2P_DIR="$DEST/models/g2p/byt5-tiny"
mkdir -p "$G2P_DIR"
for f in encoder_model.onnx decoder_model.onnx decoder_with_past_model.onnx; do
  if [[ ! -f "$G2P_DIR/$f" ]]; then
    echo "Downloading G2P $f..."
    curl -fL -o "$G2P_DIR/$f" \
      "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/$f"
  fi
done

# Piper RU is needed by piper_russian_produces_wav in tts_e2e.rs — runs
# under the same KESHA_CACHE_DIR layout.
PIPER_DIR="$DEST/models/piper-ru"
mkdir -p "$PIPER_DIR"
for f in ru_RU-denis-medium.onnx ru_RU-denis-medium.onnx.json; do
  if [[ ! -f "$PIPER_DIR/$f" ]]; then
    echo "Downloading Piper $f..."
    curl -fL -o "$PIPER_DIR/$f" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/denis/medium/$f"
  fi
done

ls -lh "$DEST"
ls -lh "$G2P_DIR"
ls -lh "$PIPER_DIR"
