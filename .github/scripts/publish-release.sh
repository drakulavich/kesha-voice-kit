#!/usr/bin/env bash
# Usage: TAG_NAME=… PRERELEASE=true|false publish-release.sh <asset-dir> <notes-file>
# One `gh release create` drafts, uploads and publishes: an immutable release refuses any asset after publication.
set -euo pipefail

dir=${1:?usage: publish-release.sh <asset-dir> <notes-file>}
notes=${2:?usage: publish-release.sh <asset-dir> <notes-file>}
: "${TAG_NAME:?}" "${PRERELEASE:?}" "${GITHUB_SHA:?}"

latest=(--latest)
[ "$PRERELEASE" = "true" ] && latest=(--prerelease --latest=false)

gh release create "$TAG_NAME" "$dir"/* --target "$GITHUB_SHA" --title "$TAG_NAME" --notes-file "$notes" "${latest[@]}"
echo "Published $TAG_NAME (prerelease=$PRERELEASE) with $(find "$dir" -maxdepth 1 -type f | wc -l | tr -d ' ') assets."
