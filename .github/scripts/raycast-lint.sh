#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
# ray lint otherwise fetches this schema live and fails on an empty body (#1292); --schema takes a data: URL, not a path.
schema="$(base64 < "$root/.github/raycast/extension-schema.json" | tr -d '\n')"
cd "$root/raycast"
exec npx --no-install ray lint --schema "data:application/json;base64,$schema"
