#!/usr/bin/env bash
# Download the Kokoro + CharsiuG2P models the CI tts lanes actually read.
# Called by rust-test.yml; cache warms on subsequent runs.
#
# Kokoro files land directly in $DEST (legacy layout — the test env vars
# KOKORO_MODEL / KOKORO_VOICE take direct paths) and are hardlinked into the
# runtime layout below, which is what KESHA_CACHE_DIR=$DEST resolves against.
set -euo pipefail

DEST="${1:?usage: download-kokoro.sh <dest_dir>}"
mkdir -p "$DEST"

# Every download in this script is guarded by a `! -f` check, which makes a
# truncated file permanently indistinguishable from a complete one: `curl -o`
# leaves a stump behind when a transfer dies mid-flight, and every later run then
# treats it as "already have it". Land the bytes under a temp name and rename
# only once curl reports success, so a failed transfer leaves nothing.
#
# This matters more since cache-seed.yml persists whatever this produces to a
# main-scoped cache under an immutable key — a stump saved once is served to
# every PR until the key rotates.
fetch() {
  local dest="$1" url="$2"
  curl -fL -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

if [[ ! -f "$DEST/model.onnx" ]]; then
  echo "Downloading Kokoro model.onnx (kokoro-onnx official release)..."
  # Mirrors rust/src/models.rs::kokoro_manifest URL — see #207 for why we
  # switched off the HF onnx-community variant.
  fetch "$DEST/model.onnx" \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
fi

if [[ ! -f "$DEST/am_michael.bin" ]]; then
  # Default voice is am_michael per CLAUDE.md "DEFAULT TTS VOICES MUST BE MALE".
  # rust-test.yml's run-cargo-test.sh gates Kokoro e2e tests on this filename.
  echo "Downloading Kokoro am_michael.bin..."
  fetch "$DEST/am_michael.bin" \
    https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_michael.bin
fi

# Vosk-TTS Russian used to be fetched here — ~935 MB per OS, cached on three,
# and read by nothing: `vosk_ru_cache_dir_or_skip` had no callers and
# smoke-synthesis.ts deliberately excludes Russian (#741). Russian synthesis is
# covered by unit tests and the fake-engine `say.test.ts`. Re-adding it needs a
# test that consumes it, not just a manifest entry.

ls -lh "$DEST"

# Runtime cache layout (models/kokoro-82m/...) for tests that resolve Kokoro via
# KESHA_CACHE_DIR instead of the flat KOKORO_MODEL env — tts_multilang_audio.
# Hardlink the 310 MB model rather than copy (same filesystem; `ln` falls back to
# a copy on Windows git-bash).
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
    fetch "$KOKORO_DIR/voices/$v.bin" "$VOICE_BASE/$v.bin"
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
    fetch "$G2P_DIR/$f.onnx" "$G2P_BASE/$f.onnx"
  fi
done

ls -lh "$KOKORO_DIR/voices"
ls -lh "$G2P_DIR"
