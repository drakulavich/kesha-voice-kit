#!/usr/bin/env bash
# Env: GH_TOKEN, REPO.
set -euo pipefail

{
  echo "## bun audit findings ($(date -u +%Y-%m-%d))"
  echo
  echo "The weekly JS advisory re-check failed. Run \`bun audit --audit-level=high\` locally and resolve (\`bun update\` or a patched dependency release)."
  echo
  echo "Workflow run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
} > /tmp/bun-audit-body.md
bash .github/scripts/upsert-audit-issue.sh /tmp/bun-audit-body.md "JS security audit findings (weekly)"
