#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
source_file="$root/raycast/src/lib/dictation-config.ts"
backup="$(mktemp)"
cp "$source_file" "$backup"
trap 'cp "$backup" "$source_file"; rm -f "$backup"' EXIT

# ray lint runs no type check, so a lane without tsc passes this (#1333).
printf '\nexport const broken: number = "not a number";\n' >> "$source_file"

if output="$("$root/.github/scripts/raycast-lint.sh" 2>&1)"; then
  printf '%s\n' "$output"
  echo "raycast-lint.sh accepted a type error; the extension is not type-checked" >&2
  exit 1
fi
if ! grep -q 'error TS2322' <<<"$output"; then
  printf '%s\n' "$output"
  echo "raycast-lint.sh failed, but not on the type error the broken export should raise" >&2
  exit 1
fi
echo "raycast-lint.sh rejects a type error"
