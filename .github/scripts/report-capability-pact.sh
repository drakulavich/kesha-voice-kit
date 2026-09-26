#!/usr/bin/env bash
# Env: GH_TOKEN, REPO, TARGET.
set -euo pipefail

{
  echo "## $TARGET's capability pact was not confirmed against the published engine"
  echo
  echo "Read the run log before acting — the step fails for two different reasons:"
  echo
  echo "- **The shape drifted.** The log shows a \`--- committed\` / \`+++\` diff, a"
  echo "  sha256 mismatch, or an engine-version mismatch. Every per-PR assertion"
  echo "  derived from \`tests/fixtures/capabilities/$TARGET.json\` is now gating"
  echo "  against a binary nobody has. Re-record per the header of"
  echo "  \`.github/workflows/capability-pact.yml\`."
  echo "- **Verification could not run.** The log ends at the \`gh release download\`"
  echo "  or \`describe\` step. The pact is not implicated; the run proved"
  echo "  nothing either way. Common causes: a network or API failure, or the window"
  echo "  between a release merge and its tag, where \`keshaEngine.version\` names a"
  echo "  release that does not exist yet."
  echo
  echo "Workflow run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
} > /tmp/pact-body.md
bash .github/scripts/upsert-audit-issue.sh /tmp/pact-body.md "Capability pact unverified: $TARGET" pact-drift
