#!/usr/bin/env bash
# Lay the committed Kokoro stand-in out in both shapes the gated tests resolve:
# the flat pair KOKORO_MODEL/KOKORO_VOICE point at, and the runtime layout
# KESHA_CACHE_DIR resolves against (#741).
#
# Copies rather than links so Windows behaves the same as the others; it is
# ~1 KB of graph plus half a megabyte of voice pack, so the cost is noise.
set -euo pipefail

DEST="${1:?usage: stage-mini-models.sh <dest_dir>}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/fixtures/mini-models/kokoro"

if [[ ! -f "$SRC/model.onnx" ]]; then
  echo "error: no mini model at $SRC — it is committed, so this is a bad checkout" >&2
  exit 1
fi

KOKORO_DIR="$DEST/models/kokoro-82m"
mkdir -p "$KOKORO_DIR/voices"

cp "$SRC/model.onnx" "$DEST/model.onnx"
cp "$SRC/am_michael.bin" "$DEST/am_michael.bin"
cp "$SRC/model.onnx" "$KOKORO_DIR/model.onnx"
# The marker travels with every copy, or a staged mini reads as real weights and
# the tier check in common::assert_staged_tier_matches inverts.
cp "$SRC/MINI-MODEL.json" "$DEST/MINI-MODEL.json"
cp "$SRC/MINI-MODEL.json" "$KOKORO_DIR/MINI-MODEL.json"

# One stand-in pack under every voice name the suites resolve: the mini reads
# `style` for its shape only, so the bytes behind each name are irrelevant —
# only that `voices::load_voice` finds 510x256x4 of them.
for voice in am_michael em_alex ff_siwis im_nicola pm_alex; do
  cp "$SRC/am_michael.bin" "$KOKORO_DIR/voices/$voice.bin"
done

echo "Staged Kokoro stand-ins under $DEST"
