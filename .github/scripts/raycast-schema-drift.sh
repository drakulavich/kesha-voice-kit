#!/usr/bin/env bash
# Env: GH_TOKEN, REPO, RUN_URL, REPORT (true to upsert the drift issue).
set -euo pipefail

vendored=".github/raycast/extension-schema.json"
url="${SCHEMA_URL:-https://www.raycast.com/schemas/extension.json}"
live="$(mktemp)"
diff_file="$(mktemp)"

# The endpoint that flaked the PR lane (#1292) is the one read here, so retry before calling it drift.
curl -fsSL --retry 5 --retry-all-errors --retry-delay 10 "$url" -o "$live"
if ! jq -e 'type == "object"' "$live" > /dev/null 2>&1; then
  echo "$url returned no JSON schema object (empty or truncated body); this is a failed fetch, not drift, so no issue is filed" >&2
  exit 1
fi
if diff -u <(jq -S . "$vendored") <(jq -S . "$live") > "$diff_file"; then
  echo "vendored Raycast manifest schema matches $url"
  exit 0
fi
cat "$diff_file"

if [[ "${REPORT:-false}" == "true" ]]; then
  body="$(mktemp)"
  {
    echo "## The vendored Raycast manifest schema drifted from the Store's"
    echo
    echo "\`raycast-lint\` validates \`raycast/package.json\` against \`$vendored\` (#1292), and the Store now serves a different schema. Refresh the copy and re-run the lane:"
    echo
    echo '```'
    echo "curl -fsSL $url -o $vendored"
    echo '```'
    echo
    echo '```diff'
    cat "$diff_file"
    echo '```'
    echo
    echo "Workflow run: $RUN_URL"
  } > "$body"
  bash .github/scripts/upsert-audit-issue.sh "$body" "Raycast manifest schema drifted from the vendored copy" pact-drift
fi
echo "vendored Raycast manifest schema differs from $url; refresh it: curl -fsSL $url -o $vendored" >&2
exit 1
