#!/usr/bin/env bash
# Create an annotated tag from a message on stdin and push it. `TAG` names it; `SHA` picks the
# commit, defaulting to HEAD.
#
# `-F -` reads the message from stdin, so newlines and shell metacharacters in it survive
# untouched — passing it through argv with `-m` would re-expose what `env:` was protecting
# (#291). `--cleanup=verbatim` keeps the `#` heading lines a release body needs (#651).
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git tag -a "$TAG" --cleanup=verbatim -F - ${SHA:+"$SHA"}
git push origin "refs/tags/$TAG"
