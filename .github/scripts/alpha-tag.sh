#!/usr/bin/env bash
# The tag carries the notes: a CLI alpha creates no Release to hold them, and the tag is the
# one record pruning can never remove (#685). `-F -` keeps a subject line's metachars literal.
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

{
  printf 'Alpha %s\n\n' "$TAG"
  if [ -n "${PREVIOUS:-}" ]; then
    printf 'Commits since %s:\n\n' "$PREVIOUS"
    git log --no-merges --pretty='- %s (%h)' "$PREVIOUS..$SHA"
  else
    printf 'No earlier alpha or release tag to count from.\n'
  fi
} | git tag -a "$TAG" --cleanup=verbatim -F - "$SHA"

git push origin "refs/tags/$TAG"
