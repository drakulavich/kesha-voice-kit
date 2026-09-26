#!/usr/bin/env bash
# Usage: release-checksums.sh <asset-dir> — writes <asset-dir>/SHA256SUMS over every asset but the signatures.
set -euo pipefail

cd "${1:?usage: release-checksums.sh <asset-dir>}"
tmp="$(mktemp)"
find . -maxdepth 1 -type f ! -name '*.sigstore.json' ! -name 'SHA256SUMS' -print0 \
  | sort -z \
  | xargs -0 sha256sum > "$tmp"
mv "$tmp" SHA256SUMS
cat SHA256SUMS
