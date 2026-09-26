#!/usr/bin/env bash
# Env: GH_TOKEN, REPOSITORY, BRANCH, TAG_NAME.
set -euo pipefail

next_cli="$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)')"
gh pr create \
  --repo "$REPOSITORY" \
  --base main \
  --head "$BRANCH" \
  --title "chore(release): record $TAG_NAME assets and lead CLI to v$next_cli" \
  --body-file post-release-pr.md
