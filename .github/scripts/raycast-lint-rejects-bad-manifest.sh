#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
manifest="$root/raycast/package.json"
backup="$(mktemp)"
cp "$manifest" "$backup"
trap 'cp "$backup" "$manifest"; rm -f "$backup"' EXIT

# The schema forbids commas in keywords; a lane that stops validating the manifest passes this (#1292).
node -e 'const fs=require("fs"),f=process.argv[1],p=JSON.parse(fs.readFileSync(f,"utf8"));p.keywords=["bad,keyword"];fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$manifest"

if output="$("$root/.github/scripts/raycast-lint.sh" 2>&1)"; then
  printf '%s\n' "$output"
  echo "raycast-lint.sh accepted a manifest the schema forbids; manifest validation is off" >&2
  exit 1
fi
if ! grep -q 'must match pattern' <<<"$output"; then
  printf '%s\n' "$output"
  echo "raycast-lint.sh failed, but not on the schema error the bad keyword should raise" >&2
  exit 1
fi
echo "raycast-lint.sh rejects a schema-invalid manifest"
