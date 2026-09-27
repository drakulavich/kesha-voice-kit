#!/usr/bin/env bash
# Env: BRANCH.
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git switch -c "$BRANCH"
git add package.json server.json rust/Cargo.toml rust/Cargo.lock
git diff --cached --quiet && { echo "::error::No post-release changes were generated." >&2; exit 1; }
next="$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)')"
git commit -m "chore(release): lead main to v$next"
git push origin "$BRANCH"
