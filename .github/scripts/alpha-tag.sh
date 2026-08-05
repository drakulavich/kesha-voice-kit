#!/usr/bin/env bash
# The tag carries the notes: a CLI alpha creates no Release to hold them, and the tag is the
# one record pruning can never remove (#685). `-F -` keeps a subject line's metachars literal.
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# Resolved before the tag exists: a git log failing mid-pipe leaves a tag with half a message.
if [ -z "${PREVIOUS:-}" ]; then
  body="No earlier alpha or release tag to count from."
# A tag off this commit's history yields a range that reads as a changelog but is not one.
elif ! git merge-base --is-ancestor "$PREVIOUS" "$SHA"; then
  body="$PREVIOUS is not in this commit's history; no commit range to report."
else
  body=$(printf 'Commits since %s:\n\n' "$PREVIOUS"; git log --no-merges --pretty='- %s (%h)' "$PREVIOUS..$SHA")
fi

printf 'Alpha %s\n\n%s\n' "$TAG" "$body" | git tag -a "$TAG" --cleanup=verbatim -F - "$SHA"

git push origin "refs/tags/$TAG"
