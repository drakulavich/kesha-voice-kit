#!/usr/bin/env bash
# Releases in this repo are immutable: an asset uploaded to a published release 422s, so the
# packages go onto a draft and the release is un-drafted only once they are all attached.
set -euo pipefail

: "${TAG:?}" "${VERSION:?}" "${ENGINE_VERSION:?}"
DIR="${ASSET_DIR:-dist/linux-packages}"

"$(dirname "$0")/assert-release-absent.sh"

# Only the two packages and their checksums: the same directory holds the compiled wrapper
# that nfpm consumed, which is not a release asset.
( cd "$DIR" && sha256sum ./*.deb ./*.rpm > SHA256SUMS && cat SHA256SUMS )

BODY="$(mktemp)"
node "$(dirname "$0")/cli-release-body.mjs" > "$BODY"
cat "$BODY" >&2

gh release create "$TAG" \
  --draft \
  --title "v$VERSION (CLI-only)" \
  --notes-file "$BODY" \
  "$DIR"/*.deb "$DIR"/*.rpm "$DIR/SHA256SUMS"

gh release edit "$TAG" --draft=false
echo "Published $TAG with the Linux packages attached." >&2
