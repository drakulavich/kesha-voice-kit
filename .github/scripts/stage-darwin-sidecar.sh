#!/usr/bin/env bash
# cargo exposes no stable OUT_DIR path, so glob it; one copy is the smoke test's engine sibling, the other the release asset.
# Usage: stage-darwin-sidecar.sh <sidecar-name> <what-went-wrong-if-missing>
set -euo pipefail

name="${1:?usage: stage-darwin-sidecar.sh <sidecar-name> <hint>}"
hint="${2:?usage: stage-darwin-sidecar.sh <sidecar-name> <hint>}"

sidecar=$(find "rust/target/${ENGINE_TARGET:?}/release/build" -name "$name" -type f -print -quit)
if [ -z "$sidecar" ]; then
  echo "$name sidecar not found — $hint" >&2
  exit 1
fi
echo "Sidecar at: $sidecar"
cp "$sidecar" "./$name"
cp "$sidecar" "$name-darwin-arm64"
