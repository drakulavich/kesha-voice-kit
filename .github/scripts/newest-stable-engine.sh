#!/usr/bin/env bash
# Prints the highest published stable Engine version. main carries the next, unreleased version, so a lane
# that downloads a published Engine installs this one (openspec unified-release D1). Needs GH_TOKEN in CI.
set -euo pipefail

gh release list --repo drakulavich/kesha-voice-kit --limit 200 --json tagName,isDraft,isPrerelease \
  | bun "$(dirname "$0")/engine-pin.ts" newest-stable
