#!/usr/bin/env bash
# Printed when the packaging job dies. The failure may have landed between `gh release create
# --draft` and `--draft=false`, and that draft blocks a plain re-run — assert-release-absent
# counts drafts too. Which of the three recoveries applies depends on state, so look it up.
set -euo pipefail

: "${TAG:?}"

state=$(gh release view "$TAG" --json isDraft --jq 'if .isDraft then "draft" else "published" end' 2>/dev/null || echo none)

case "$state" in
  draft)
    echo "::error::$TAG failed with a draft release left behind. It blocks a re-run of this lane, so clear it one of two ways." >&2
    gh release view "$TAG" --json assets --jq '"Assets on the draft: " + ([.assets[].name] | join(", "))' >&2 || true
    cat >&2 <<EOF
  - The .deb, .rpm and SHA256SUMS are all there — finish it by hand:
      gh release edit $TAG --draft=false
      gh workflow run npm-publish.yml --ref $TAG -f tag=$TAG
  - Anything missing or wrong — delete the draft and re-run the lane:
      gh release delete $TAG --yes
      gh workflow run release-cli.yml -f tag=$TAG
    Deleting is safe while it is a draft: only publishing reserves the tag name permanently.
EOF
    ;;
  published)
    echo "::error::$TAG failed after its release went public. The packages are already out; npm is what is missing, and re-running the publish alone is idempotent: gh workflow run npm-publish.yml --ref $TAG -f tag=$TAG" >&2
    ;;
  *)
    echo "::error::$TAG failed before any release was created, so there is nothing to clean up — fix the cause and re-run the lane: gh workflow run release-cli.yml -f tag=$TAG" >&2
    ;;
esac
