#!/usr/bin/env bash
# The registry serves a fresh version a beat after the publish run goes green, so poll.
set -euo pipefail

: "${VERSION:?}"
PACKAGE="@drakulavich/kesha-voice-kit"

for _ in $(seq 1 12); do
  if [ "$(npm view "$PACKAGE@$VERSION" version 2>/dev/null || true)" = "$VERSION" ]; then
    echo "$PACKAGE@$VERSION is on npm."
    exit 0
  fi
  sleep 5
done

echo "::error::$PACKAGE@$VERSION is still not on npm a minute after the publish run succeeded. The GitHub release and its Linux packages are already public, so re-run the publish alone: gh workflow run npm-publish.yml --ref v$VERSION-cli -f tag=v$VERSION-cli" >&2
exit 1
