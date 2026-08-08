#!/usr/bin/env bash
# Releases here are immutable, so neither attaching to nor replacing an existing one is
# possible — the only thing this lane can do about it is say so before it builds anything.
set -euo pipefail

: "${TAG:?}"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "::error::A GitHub release already exists for $TAG (draft or published), and releases here are immutable — this lane cannot add the Linux packages to it. A release cut by hand with \`gh release create\` publishes npm but ships no packages; to get packages, bump the patch version and push a new vX.Y.Z-cli tag. Tag names are one-use." >&2
  exit 1
fi
