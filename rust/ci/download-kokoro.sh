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

# Runtime cache layout (models/kokoro-82m/...) for tests that resolve Kokoro
# via KESHA_CACHE_DIR instead of the flat KOKORO_MODEL env — tts_multilang_audio
# and the tts_stdin_loop cache path. Hardlink the 310 MB model rather than copy
# (same filesystem; `ln` falls back to a copy on Windows git-bash).
KOKORO_DIR="$DEST/models/kokoro-82m"
mkdir -p "$KOKORO_DIR/voices"
if [[ ! -f "$KOKORO_DIR/model.onnx" ]]; then
  ln -f "$DEST/model.onnx" "$KOKORO_DIR/model.onnx" 2>/dev/null \
    || cp "$DEST/model.onnx" "$KOKORO_DIR/model.onnx"
fi
if [[ ! -f "$KOKORO_DIR/voices/am_michael.bin" ]]; then
  ln -f "$DEST/am_michael.bin" "$KOKORO_DIR/voices/am_michael.bin" 2>/dev/null \
    || cp "$DEST/am_michael.bin" "$KOKORO_DIR/voices/am_michael.bin"
fi

# Multilingual voices (es/fr/it/pt) — URLs mirror rust/src/models.rs multilang
# voice manifest. em_alex/im_nicola/pm_alex are male; ff_siwis is the documented
# French brand-rule exception (Kokoro v1.0 ships no male French voice).
VOICE_BASE="https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices"
for v in em_alex ff_siwis im_nicola pm_alex; do
  if [[ ! -f "$KOKORO_DIR/voices/$v.bin" ]]; then
    echo "Downloading Kokoro voice $v.bin..."
    curl -fL -o "$KOKORO_DIR/voices/$v.bin" "$VOICE_BASE/$v.bin"
  fi
done

# CharsiuG2P byt5-tiny ONNX (es/fr/it/pt phonemisation). URLs mirror
# rust/src/models.rs; the loader (charsiu::load) opens exactly these three.
# run-cargo-test.sh exports CHARSIU_ONNX pointing at this dir.
G2P_DIR="$DEST/models/g2p/byt5-tiny"
mkdir -p "$G2P_DIR"
G2P_BASE="https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main"
for f in encoder_model decoder_model decoder_with_past_model; do
  if [[ ! -f "$G2P_DIR/$f.onnx" ]]; then
    echo "Downloading CharsiuG2P $f.onnx..."
    curl -fL -o "$G2P_DIR/$f.onnx" "$G2P_BASE/$f.onnx"
  fi
done

ls -lh "$DEST"
ls -lh "$VOSK_DIR"
ls -lh "$VOSK_DIR/bert"
ls -lh "$KOKORO_DIR/voices"
ls -lh "$G2P_DIR"
