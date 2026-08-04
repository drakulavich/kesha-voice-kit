#!/usr/bin/env bash
# A manual run is deliberate and skips both gates; a push must carry the label AND touch
# something npm packs, so a labelled docs-only PR still publishes nothing (#685).
set -euo pipefail

if [ "${MANUAL:-false}" = "true" ]; then
  echo "publish=true"
  echo "Manual run — publishing without the label check." >&2
  exit 0
fi

labels=$(gh api "repos/${GITHUB_REPOSITORY}/commits/${SHA}/pulls" --jq '[.[].labels[].name] | join(",")' 2>/dev/null || echo "")
if [ "$PACKED" = "true" ] && printf '%s' ",$labels," | grep -q ',alpha,'; then
  echo "publish=true"
  echo "PR carries the alpha label and changed packed files — publishing." >&2
else
  echo "publish=false"
  echo "Not publishing: packed=${PACKED}, labels=[${labels}] (needs the 'alpha' label)." >&2
fi
