#!/usr/bin/env bash
set -euo pipefail

bun link
# shellcheck disable=SC2206 # INSTALL_ARGS carries several `kesha install` flags, split on purpose.
args=(${INSTALL_ARGS:-})
# A staged KESHA_ENGINE_BIN is this run's own build; anything else is the highest published stable Engine,
# because main carries the next, unreleased version.
if [ -z "${KESHA_ENGINE_BIN:-}" ]; then
  args+=(--engine-version "$(bash "$(dirname "$0")/newest-stable-engine.sh")")
fi
if [ -n "${INSTALL_LOG:-}" ]; then
  kesha install "${args[@]}" 2>&1 | tee "$INSTALL_LOG"
else
  kesha install "${args[@]}"
fi
