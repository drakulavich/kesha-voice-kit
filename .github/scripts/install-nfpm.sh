#!/usr/bin/env bash
# Release binary, not `go install`: an unpinned Go failed on sum.golang.org (run 34351331531).
set -euo pipefail

VERSION="2.43.4"
SHA256="cafb544650cb0305d1b164fc0ab261eb77a81af324e18011282d326b326d20fb"
ASSET="nfpm_${VERSION}_Linux_x86_64.tar.gz"
URL="https://github.com/goreleaser/nfpm/releases/download/v${VERSION}/${ASSET}"
DEST="${1:-${RUNNER_TEMP:?RUNNER_TEMP is unset; pass an install dir}/nfpm}"

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

tar -xzf "$DEST/$ASSET" -C "$DEST" nfpm
rm "$DEST/$ASSET"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$DEST" >> "$GITHUB_PATH"
fi
echo "nfpm $VERSION installed to $DEST (sha256 verified)"
