#!/usr/bin/env bash
# Env: GH_TOKEN, REPO.
set -euo pipefail

{
  echo "## The Kokoro mini-model pact was not confirmed against the real weights"
  echo
  echo "Read the run log before acting — this fails for three different reasons:"
  echo
  echo "- **The signature drifted.** The log shows a \`left\`/\`right\` mismatch of"
  echo "  tensor names, dtypes or ranks. Every mini-backed lane is now asserting"
  echo "  against a shape the real model no longer has. Re-record per the header of"
  echo "  \`.github/workflows/nightly.yml (mini-model-pact job)\` — and regenerate the mini too,"
  echo "  or the recording will match the real model but not the stand-in."
  echo "- **The committed mini is not what the generator produces.** The log shows"
  echo "  a \`git diff\` against tests/fixtures/mini-models/kokoro. Someone edited the"
  echo "  fixture by hand, or the onnx version moved. Regenerate per the generator's"
  echo "  header and commit the result."
  echo "- **Verification could not run.** The log ends at the download or the"
  echo "  sha256 check. The pact is not implicated; the run proved nothing either"
  echo "  way. Usually a network failure or an upstream re-upload."
  echo
  echo "Workflow run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
} > /tmp/mini-pact-body.md
bash .github/scripts/upsert-audit-issue.sh /tmp/mini-pact-body.md "Mini-model pact unverified: kokoro-82m" pact-drift
