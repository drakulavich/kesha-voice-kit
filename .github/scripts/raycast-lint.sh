#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
# ray lint otherwise fetches this schema live and fails on an empty body (#1292); --schema takes a data: URL, not a path.
schema="$(base64 < "$root/.github/raycast/extension-schema.json" | tr -d '\n')"
cd "$root/raycast"
# The author lookup appends /api/v1/users/<name> to RAY_APIURL; base64 decoding stops at "=", so every user resolves to {} offline (#1311).
RAY_APIURL="data:application/json;base64,e30=" \
NODE_OPTIONS="--require \"$root/.github/scripts/raycast-no-live-fetch.cjs\"" \
  exec npx --no-install ray lint --schema "data:application/json;base64,$schema"
