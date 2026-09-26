#!/usr/bin/env bash
# Env: BRANCH.
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git switch -c "$BRANCH"
git add package.json server.json src/engine-targets.ts
git diff --cached --quiet && { echo "::error::No post-release changes were generated." >&2; exit 1; }
next_cli="$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)')"
git commit -m "chore(release): lead CLI base to v$next_cli"
git push origin "$BRANCH"
