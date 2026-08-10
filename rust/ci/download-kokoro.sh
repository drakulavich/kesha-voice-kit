#!/usr/bin/env bash
# Download the TTS models that have no stand-in: CharsiuG2P always, Vosk-RU when
# the caller asks. Kokoro is served by the committed mini instead (#741).
# Called by rust-test.yml; cache warms on subsequent runs.
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

# Kokoro's graph and voice packs are no longer fetched: the committed stand-in in
# tests/fixtures/mini-models/kokoro carries the same I/O signature for ~1 KB, and
# rust/ci/stage-mini-models.sh lays it out (#741). Only weights nothing can stand
# in for are downloaded here.

# Vosk-TTS Russian, ~935 MB. Exactly one consumer:
# `tts::vosk::tests::synth_short_phrase_produces_audio`, which needs real weights
# (the ONNX sessions live inside the vosk_tts crate, so nothing can stand in for
# them). One lane running it is the whole boundary — Vosk behaves the same on
# every OS — so only the caller that passes WITH_VOSK=1 pays for it instead of
# all three (#741).
if [[ "${WITH_VOSK:-0}" == "1" ]]; then
  VOSK_DIR="$DEST/models/vosk-ru"
  mkdir -p "$VOSK_DIR/bert"
  VOSK_BASE="https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main"
  download_if_missing() {
    local rel="$1"
    if [[ ! -f "$VOSK_DIR/$rel" ]]; then
      echo "Downloading Vosk $rel..."
      fetch "$VOSK_DIR/$rel" "$VOSK_BASE/$rel"
    fi
  }
  # Bare `wait` reports success even when a background job failed, so a partial
  # bundle used to reach the caller as exit 0 — and cache-seed.yml would then
  # persist it on main under an immutable key that never self-heals. Wait on each
  # PID and propagate the first failure instead.
  vosk_pids=()
  for rel in model.onnx dictionary config.json bert/model.onnx bert/vocab.txt; do
    download_if_missing "$rel" &
    vosk_pids+=("$!")
  done
  vosk_failed=0
  for pid in "${vosk_pids[@]}"; do
    wait "$pid" || vosk_failed=1
  done
  if [[ "$vosk_failed" -ne 0 ]]; then
    echo "error: at least one Vosk download failed; refusing to report a partial bundle" >&2
    exit 1
  fi
  ls -lh "$VOSK_DIR" "$VOSK_DIR/bert"
fi

ls -lh "$DEST"

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

ls -lh "$G2P_DIR"
