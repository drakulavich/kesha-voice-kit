#!/bin/bash
# Stage a file, commit with a message, and push with retry.
# Usage: commit-and-push.sh <file> <message>

set -euo pipefail

FILE="${1:?Usage: commit-and-push.sh <file> <message>}"
MESSAGE="${2:?Usage: commit-and-push.sh <file> <message>}"

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
