#!/usr/bin/env bash
# Env: GH_TOKEN, REPO.
set -euo pipefail

{
  echo "## cargo-deny findings ($(date -u +%Y-%m-%d))"
  echo
  echo "The weekly advisory re-check failed. Run \`cd rust && cargo deny check\` locally and triage into \`rust/deny.toml\`."
  echo
  echo "Workflow run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
} > /tmp/audit-body.md
bash .github/scripts/upsert-audit-issue.sh /tmp/audit-body.md
