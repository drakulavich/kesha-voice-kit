#!/usr/bin/env bash
# Pinned release binary with a verified SHA-256, the same shape as install-nfpm.sh (openspec unified-release D5).
set -euo pipefail

VERSION="1.7.12"
SHA256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
ASSET="actionlint_${VERSION}_linux_amd64.tar.gz"
URL="https://github.com/rhysd/actionlint/releases/download/v${VERSION}/${ASSET}"
DEST="${1:-${RUNNER_TEMP:?RUNNER_TEMP is unset; pass an install dir}/actionlint}"

mkdir -p "$DEST"
curl -fsSL --retry 3 -o "$DEST/$ASSET" "$URL"
actual=$(shasum -a 256 "$DEST/$ASSET" | cut -d' ' -f1)
if [[ "$actual" != "$SHA256" ]]; then
  echo "error: sha256 mismatch for $URL" >&2
  echo "  pinned: $SHA256" >&2
  echo "  actual: $actual" >&2
  rm -f "$DEST/$ASSET"
  exit 1
fi

tar -xzf "$DEST/$ASSET" -C "$DEST" actionlint
rm "$DEST/$ASSET"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$DEST" >> "$GITHUB_PATH"
fi
echo "actionlint $VERSION installed to $DEST (sha256 verified)"
