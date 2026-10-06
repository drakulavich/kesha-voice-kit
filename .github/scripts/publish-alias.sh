#!/usr/bin/env bash
# Publish the unscoped `kesha` alias pinned to the version this release just published (#1413).
set -euo pipefail
cd packages/kesha
npm pkg set version="$VERSION" "dependencies.@drakulavich/kesha-voice-kit=$VERSION"
if npm view "kesha@$VERSION" version >/dev/null 2>&1; then
  echo "kesha@$VERSION is already on npm."
  exit 0
fi
npm publish --provenance --access public --tag "$NPM_DIST_TAG"
