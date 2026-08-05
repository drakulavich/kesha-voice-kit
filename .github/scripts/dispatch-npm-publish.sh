#!/usr/bin/env bash
# npm Trusted Publishing validates the name of the workflow that *entered* the run, and a
# package may configure only one, so an alpha has to publish through npm-publish.yml (#731).
set -euo pipefail

WORKFLOW=npm-publish.yml

latest_dispatch_run() {
  gh run list --workflow "$WORKFLOW" --event workflow_dispatch --limit 1 \
    --json databaseId --jq '.[0].databaseId // 0'
}

before=$(latest_dispatch_run)
gh workflow run "$WORKFLOW" -f tag="$TAG"
echo "Dispatched $WORKFLOW for $TAG." >&2

run="$before"
for _ in $(seq 1 30); do
  sleep 2
  run=$(latest_dispatch_run)
  [ "$run" != "$before" ] && break
done

# A dispatch that never became a run would leave the tag reserved and nothing published,
# which is the failure this whole gate exists to make impossible to miss.
if [ "$run" = "$before" ]; then
  echo "::error::$WORKFLOW never started for $TAG — the version is tagged but unpublished." >&2
  exit 1
fi

echo "Watching run $run." >&2
gh run watch "$run" --exit-status
