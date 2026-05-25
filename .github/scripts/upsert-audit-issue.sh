#!/usr/bin/env bash
# Upsert a single findings issue when the weekly cron detects advisory/license
# problems. Reuses one issue (by exact title + label) instead of opening a new
# one each week. Mirrors the upsert pattern in cargo-dependency-maintenance.yml.
#
# Usage: upsert-audit-issue.sh <body-file> [title]
#   <title> defaults to the Rust findings issue. The bun-audit job passes its
#   own title so Rust and JS findings live in separate issues and never clobber
#   each other's body on a shared cron run.
#   Env: GH_TOKEN, REPO (owner/name)
set -euo pipefail

body_file="$1"
title="${2:-Security audit findings (weekly)}"
label="security"

existing="$(
  gh issue list -R "$REPO" --state open --label "$label" \
    --search "in:title \"$title\"" \
    --json number,title \
    --jq "map(select(.title == \"$title\")) | first | .number // empty"
)"

if [[ -n "$existing" ]]; then
  gh issue edit "$existing" -R "$REPO" --body-file "$body_file"
  gh issue comment "$existing" -R "$REPO" \
    --body "Re-checked $(date -u +%Y-%m-%d): findings updated above."
else
  gh label create "$label" -R "$REPO" --color B60205 \
    --description "Automated security-audit findings" 2>/dev/null || true
  gh issue create -R "$REPO" --title "$title" --label "$label" --body-file "$body_file"
fi
