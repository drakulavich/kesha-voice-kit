#!/usr/bin/env bash
# Download the TTS models the caller asks for. CharsiuG2P always; Vosk-RU and the
# real Kokoro weights only behind their flags, which only the weekly canary sets.
# The PR lanes run on the committed Kokoro stand-in instead (#741).
# Called by ci.yml's Rust lanes; cache warms on subsequent runs.
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

fetch_verified() {
  local dest="$1" url="$2" expected="$3" actual
  fetch "$dest" "$url"
  actual=$(shasum -a 256 "$dest" | cut -d' ' -f1)
  if [[ "$actual" != "$expected" ]]; then
    echo "error: sha256 mismatch for $url (pinned $expected, got $actual)." >&2
    echo "Update the pins here and in rust/src/models/manifest.rs together (verify-pin-bump)." >&2
    rm -f "$dest"
    exit 1
  fi
}

# Pins copied from rust/src/models/manifest.rs; tests/unit/fixture-pins.test.ts keeps them equal.
KOKORO_MODEL_URL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
KOKORO_MODEL_SHA256=7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5
KOKORO_VOICE_REVISION=1939ad2a8e416c0acfeecc08a694d14ef25f2231
KOKORO_VOICE_SHA256_am_michael=1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1
KOKORO_VOICE_SHA256_em_alex=27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95
KOKORO_VOICE_SHA256_ff_siwis=a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861
KOKORO_VOICE_SHA256_im_nicola=bc578e510d52a96d6940d46f12e96d7b3df00905dbea075113226d100e6e1ab0
KOKORO_VOICE_SHA256_pm_alex=0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a

# Kokoro's graph and voice packs are not fetched for the PR lanes: the committed
# stand-in in tests/fixtures/mini-models/kokoro carries the same I/O signature for
# ~1 KB, and rust/ci/stage-mini-models.sh lays it out (#741).
#
# WITH_REAL_KOKORO is the canary's opt-in. Weekly, nightly.yml's `real-model-canary` job runs the
# same suites against these weights, which is the only place real Kokoro audio is
# asserted at all now — so this arm is the counterweight to the stand-ins, not a
# leftover.
if [[ "${WITH_REAL_KOKORO:-0}" == "1" ]]; then
  if [[ ! -f "$DEST/model.onnx" ]]; then
    echo "Downloading Kokoro model.onnx (kokoro-onnx official release)..."
    fetch_verified "$DEST/model.onnx" "$KOKORO_MODEL_URL" "$KOKORO_MODEL_SHA256"
  fi
  KOKORO_DIR="$DEST/models/kokoro-82m"
  mkdir -p "$KOKORO_DIR/voices"
  ln -f "$DEST/model.onnx" "$KOKORO_DIR/model.onnx" 2>/dev/null \
    || cp "$DEST/model.onnx" "$KOKORO_DIR/model.onnx"
  # am_michael is the male brand default (CLAUDE.md); the rest carry the multilang
  # corpus. ff_siwis is the documented French exception.
  VOICE_BASE="https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/$KOKORO_VOICE_REVISION/voices"
  for v in am_michael em_alex ff_siwis im_nicola pm_alex; do
    if [[ ! -f "$KOKORO_DIR/voices/$v.bin" ]]; then
      echo "Downloading Kokoro voice $v.bin..."
      sha_var="KOKORO_VOICE_SHA256_$v"
      fetch_verified "$KOKORO_DIR/voices/$v.bin" "$VOICE_BASE/$v.bin" "${!sha_var}"
    fi
  done
  ln -f "$KOKORO_DIR/voices/am_michael.bin" "$DEST/am_michael.bin" 2>/dev/null \
    || cp "$KOKORO_DIR/voices/am_michael.bin" "$DEST/am_michael.bin"
  ls -lh "$KOKORO_DIR/voices"
fi

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
# rust/src/models/manifest.rs; the loader (charsiu::load) opens exactly these three.
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
