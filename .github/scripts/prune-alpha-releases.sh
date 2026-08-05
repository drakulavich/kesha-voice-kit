#!/usr/bin/env bash
# `gh release delete` without --cleanup-tag: the Release goes, the tag stays (#685).
set -euo pipefail

# Paginated: `gh release list --limit N` returns the newest N, losing alphas as they age out.
releases=$(gh api "repos/{owner}/{repo}/releases" --paginate |
  jq -s 'add | [.[] | {tagName: .tag_name, publishedAt: .published_at, isDraft: .draft}]')
aged=$(printf '%s' "$releases" | bun .github/scripts/prune-alpha-releases.ts)

if [ -z "$aged" ]; then
  echo "No alpha release has aged out."
  exit 0
fi

while IFS= read -r tag; do
  echo "Deleting aged-out alpha release $tag (tag kept)."
  gh release delete "$tag" --yes
done <<< "$aged"
