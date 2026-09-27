#!/usr/bin/env bash
# Env: GH_TOKEN, REPOSITORY, BRANCH, TAG_NAME.
set -euo pipefail

existing="$(gh pr list --repo "$REPOSITORY" --head "$BRANCH" --state all --json title,body)"
count="$(printf '%s' "$existing" | jq 'length')"
if [ "$count" = "1" ]; then
  expected="$(printf '%s' "$existing" | jq --arg tag "$TAG_NAME" '
    ((.[0].title | startswith("chore(release): record " + $tag + " assets and lead main to v"))
    and (.[0].body | contains("Published engine tag: `" + $tag + "`")))
  ')"
  if [ "$expected" = "true" ]; then
    echo "skip=true" >> "$GITHUB_OUTPUT"
    echo "A matching follow-up PR for $TAG_NAME is already open; leaving it untouched."
    exit 0
  fi
  echo "::error::An unrelated PR already uses $BRANCH; refusing to touch it." >&2
  exit 1
fi
if [ "$count" != "0" ]; then
  echo "::error::More than one open PR uses $BRANCH; refusing an ambiguous follow-up." >&2
  exit 1
fi
echo "skip=false" >> "$GITHUB_OUTPUT"
