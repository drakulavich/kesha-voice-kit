#!/bin/bash
# Stage a file, commit, and push with retry.
# Usage: commit-and-push.sh <file> [message]
# Default message: "ci: update <file>"

set -euo pipefail

FILE="${1:?Usage: commit-and-push.sh <file> [message]}"
MESSAGE="${2:-ci: update $FILE}"

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add "$FILE"

if git diff --cached --quiet; then
  echo "No changes to commit"
else
  git commit -m "$MESSAGE"
  git pull --rebase origin main
  git push || (git pull --rebase origin main && git push)
fi
