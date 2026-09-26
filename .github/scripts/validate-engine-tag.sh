#!/usr/bin/env bash
# Shape check runs before the tag reaches any filesystem/argv site; `-cli` marker tags are the CLI's, not ours (#685).
set -euo pipefail

if ! [[ "$INPUT_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-(beta|alpha)\.[0-9]+)?$ ]]; then
  echo "::error::Tag '$INPUT_TAG' must match vX.Y.Z, vX.Y.Z-beta.N or vX.Y.Z-alpha.N (CLI marker tags ending in -cli are not supported by this workflow)"
  exit 1
fi
if git rev-parse "refs/tags/$INPUT_TAG" >/dev/null 2>&1; then
  echo "::error::Tag $INPUT_TAG already exists. Tag names are one-use (CLAUDE.md → TAG NAMES ARE ONE-USE) — bump patch and retry."
  exit 1
fi
echo "Tag $INPUT_TAG passes shape + uniqueness checks."
