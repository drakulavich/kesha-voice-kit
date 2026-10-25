#!/usr/bin/env bash
# Env: GH_TOKEN, REPOSITORY.
set -euo pipefail

if git diff --quiet -- tests/fixtures/capabilities; then
  echo "The re-recorded pacts match the committed ones; no PR to open." >&2
  exit 0
fi
version="$(bun -e 'console.log(JSON.parse(await Bun.file("tests/fixtures/capabilities/linux-x64.provenance.json").text()).engineVersion)')"
branch="automation/capability-pact-v$version"
run_url="$GITHUB_SERVER_URL/$REPOSITORY/actions/runs/$GITHUB_RUN_ID"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git switch -c "$branch"
git add tests/fixtures/capabilities
git commit -m "test(pact): record the capability pacts from the v$version engines"
git push origin "$branch"
gh pr create \
  --repo "$REPOSITORY" \
  --base main \
  --head "$branch" \
  --title "test(pact): record the capability pacts from the v$version engines" \
  --body "Re-recorded by [Nightly run $GITHUB_RUN_ID]($run_url) (\`job: capability-pact\`, \`record: true\`) from the v$version engines. A PR opened by \`GITHUB_TOKEN\` starts no CI: close and reopen it to run \`tests/unit/capabilities-pact.test.ts\`, then merge."
