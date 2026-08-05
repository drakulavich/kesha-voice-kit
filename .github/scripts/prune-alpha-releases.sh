#!/usr/bin/env bash
# `gh release delete` without --cleanup-tag: the Release goes, the tag stays (#685).
set -euo pipefail

LIMIT=1000
releases=$(gh release list --limit "$LIMIT" --json tagName,publishedAt,isDraft)

# Hitting the cap means the oldest releases were never seen, and those are the prunable ones.
if [ "$(printf '%s' "$releases" | jq 'length')" -ge "$LIMIT" ]; then
  echo "::error::release list hit its $LIMIT cap — aged alphas may be invisible to the selector" >&2
  exit 1
fi

aged=$(printf '%s' "$releases" | bun .github/scripts/prune-alpha-releases.ts)

if [ -z "$aged" ]; then
  echo "No alpha release has aged out."
  exit 0
fi

while IFS= read -r tag; do
  echo "Deleting aged-out alpha release $tag (tag kept)."
  gh release delete "$tag" --yes
done <<< "$aged"
