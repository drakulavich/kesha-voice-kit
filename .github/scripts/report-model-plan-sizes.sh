#!/usr/bin/env bash
# Env: GH_TOKEN, REPO, RUN_URL; reads /tmp/model-plan-sizes.log from the check step.
set -euo pipefail

{
  echo "## model-plan.json no longer matches the bytes upstream serves"
  echo
  echo "Read the log below before acting — the step fails for three different reasons:"
  echo
  echo "- **A recorded size is wrong.** Lines beginning \`DRIFT\` name the file, the"
  echo "  recorded and live byte counts, and the delta. \`kesha install --plan\` is"
  echo "  quoting that number to users. Correct \`sizeBytes\` in model-plan.json from"
  echo "  the live figure; it is the truth by construction."
  echo "- **A plan entry has no URL.** The run stopped before any request, naming the"
  echo "  entries it could not resolve. Either rust/src/models/manifest.rs dropped the file, or"
  echo "  \`.github/scripts/check-model-plan-sizes.ts\` stopped being able to read it."
  echo "- **The sizes could not be checked.** Lines beginning \`UNCHECKED\` mean no"
  echo "  Content-Length came back. The plan is not implicated; the run proved nothing"
  echo "  about those entries either way."
  echo
  echo '```'
  cat /tmp/model-plan-sizes.log
  echo '```'
  echo
  echo "Workflow run: $RUN_URL"
} > /tmp/model-plan-body.md
bash .github/scripts/upsert-audit-issue.sh /tmp/model-plan-body.md "Install plan sizes drifted from upstream" pact-drift
