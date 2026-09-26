#!/usr/bin/env bash
set -euo pipefail

bun link
# shellcheck disable=SC2086 # INSTALL_ARGS carries several `kesha install` flags, split on purpose.
if [ -n "${INSTALL_LOG:-}" ]; then
  kesha install ${INSTALL_ARGS:-} 2>&1 | tee "$INSTALL_LOG"
else
  kesha install ${INSTALL_ARGS:-}
fi
