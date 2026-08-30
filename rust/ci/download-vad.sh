#!/usr/bin/env bash
# Stage the pinned Silero VAD (2.3 MB) so the span goldens in
# rust/tests/vad_spans.rs actually run. No lane downloaded this before #990, so
# the VAD had no cross-platform coverage at all.
#
# URL and hash mirror rust/src/models.rs::VAD_FILES; models.rs's
# `ci_download_script_matches_the_pinned_vad_manifest` fails if they drift, so a
# pin bump has to land in both places.
set -euo pipefail

DEST="${1:?usage: download-vad.sh <cache_dir>}"

URL="https://github.com/snakers4/silero-vad/raw/7e30209a3e901f9842f81b225f3e93d8199902b1/src/silero_vad/data/silero_vad.onnx"
SHA256="1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"

VAD_DIR="$DEST/models/silero-vad"
TARGET="$VAD_DIR/silero_vad.onnx"
mkdir -p "$VAD_DIR"

# macOS ships shasum, Linux and Git-Bash ship sha256sum.
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

verify() {
  [[ -f "$1" ]] || return 1
  local got
  got="$(sha_of "$1")"
  [[ "$got" == "$SHA256" ]]
}

if verify "$TARGET"; then
  echo "Silero VAD already staged and verified at $TARGET"
  exit 0
fi

# A cache entry that restored a truncated or stale file is indistinguishable
# from a missing one only after hashing, which is why the check above runs first
# and this deletes rather than trusting what is there.
rm -f "$TARGET"

# github.com fails in multi-second bursts that a sub-second retry cannot span,
# so back off in whole seconds rather than milliseconds.
for attempt in 1 2 3; do
  echo "Downloading Silero VAD (attempt $attempt)..."
  if curl -fL --retry 2 --retry-delay 2 -o "$TARGET.part" "$URL"; then
    if verify "$TARGET.part"; then
      mv "$TARGET.part" "$TARGET"
      echo "Silero VAD staged at $TARGET"
      exit 0
    fi
    echo "sha256 mismatch: expected $SHA256, got $(sha_of "$TARGET.part")" >&2
  fi
  rm -f "$TARGET.part"
  sleep $((attempt * 3))
done

echo "error: could not stage a verified Silero VAD from $URL" >&2
exit 1
