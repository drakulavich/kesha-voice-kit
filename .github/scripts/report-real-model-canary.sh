#!/usr/bin/env bash
# Env: GH_TOKEN, REPO.
set -euo pipefail

{
  echo "## The real-model canary failed"
  echo
  echo "Read the run log before acting — this fails for three different reasons:"
  echo
  echo "- **A real model regressed.** The suite ran and a test failed. Every per-PR"
  echo "  lane is on stand-ins, so this is the only place that signal exists, and"
  echo "  the regression may be up to a week old. Do not dismiss it as flake."
  echo "- **A gate resolved to a stand-in.** The failure names"
  echo "  \`KESHA_REQUIRE_MODEL_TESTS asks for Real\`. The staging is wrong, not the"
  echo "  model — this lane must never run on the committed mini."
  echo "- **The download could not run.** The log ends in the download step. The"
  echo "  models are not implicated; the run proved nothing either way."
  echo
  echo "Workflow run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
} > /tmp/canary-body.md
bash .github/scripts/upsert-audit-issue.sh /tmp/canary-body.md "Real-model canary failing" pact-drift
