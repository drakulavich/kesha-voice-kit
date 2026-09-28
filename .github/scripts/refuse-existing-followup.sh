#!/usr/bin/env bash
# Env: GH_TOKEN, REPOSITORY, BRANCH, TAG_NAME.
set -euo pipefail

gh pr list --repo "$REPOSITORY" --head "$BRANCH" --state all --json title,body \
  | bun .github/scripts/post-release-guard.ts existing >> "$GITHUB_OUTPUT"
