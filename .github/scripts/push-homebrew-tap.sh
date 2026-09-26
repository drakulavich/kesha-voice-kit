#!/usr/bin/env bash
# Env: TAG, TAP_REPO; run from the workspace root with the tap cloned at ./tap.
set -euo pipefail

cd tap
tap_branch="$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')"
test -n "$tap_branch" || {
  echo "::error::Could not resolve default branch for $TAP_REPO"
  exit 1
}
if git diff --quiet -- Formula/kesha-voice-kit.rb; then
  echo "Homebrew formula already matches $TAG"
  exit 0
fi
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add Formula/kesha-voice-kit.rb
git commit -m "Update Kesha Voice Kit to $TAG"
git push origin "HEAD:$tap_branch"
