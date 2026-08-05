#!/usr/bin/env bash
# The tag carries the notes: a CLI alpha creates no Release to hold them, and the tag is the
# one record pruning can never remove (#685). `-F -` keeps a subject line's metachars literal.
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# This channel's release shapes only: `audio-244` exists here, and so do the other artifact's tags.
if [ "${TAG%-cli}" != "$TAG" ]; then
  reachable=(--match 'v[0-9]*-cli')
else
  reachable=(--match 'v[0-9]*' --exclude 'v*-cli')
fi

if [ -z "${PREVIOUS:-}" ]; then
  base=""
elif git merge-base --is-ancestor "$PREVIOUS" "$SHA"; then
  base="$PREVIOUS"
else
  base=$(git describe --tags --abbrev=0 "${reachable[@]}" "$SHA" 2>/dev/null || true)
fi

# Resolved before the tag exists: a git log failing mid-pipe leaves a tag with half a message.
if [ -n "$base" ]; then
  body=$(printf 'Commits since %s:\n\n' "$base"; git log --no-merges --pretty='- %s (%h)' "$base..$SHA")
else
  body="No earlier tag in this commit's history to count from."
fi

printf 'Alpha %s\n\n%s\n' "$TAG" "$body" | git tag -a "$TAG" --cleanup=verbatim -F - "$SHA"

git push origin "refs/tags/$TAG"
