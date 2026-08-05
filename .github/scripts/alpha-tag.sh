#!/usr/bin/env bash
# The tag carries the notes: a CLI alpha creates no Release to hold them, and the tag is the
# one record pruning can never remove (#685). `-F -` keeps a subject line's metachars literal.
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# Resolved before the tag exists: a git log failing mid-pipe leaves a tag with half a message.
if [ -n "${PREVIOUS:-}" ]; then
  body=$(printf 'Commits since %s:\n\n' "$PREVIOUS"; git log --no-merges --pretty='- %s (%h)' "$PREVIOUS..$SHA")
else
  body="No earlier alpha or release tag to count from."
fi

printf 'Alpha %s\n\n%s\n' "$TAG" "$body" | git tag -a "$TAG" --cleanup=verbatim -F - "$SHA"

git push origin "refs/tags/$TAG"
