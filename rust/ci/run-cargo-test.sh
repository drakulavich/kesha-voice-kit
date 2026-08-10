#!/usr/bin/env bash
# Run the nextest suite against the workflow's warm model cache. The env
# staging lives in kokoro-env.sh so the coverage lane gates identically.
set -euo pipefail

KOKORO_CACHE="${1:?usage: run-cargo-test.sh <kokoro_cache> <runner_os>}"
RUNNER_OS="${2:?}"
CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$RUNNER_OS" in
  macOS|Linux|Windows) ;;
  *)
    echo "unsupported runner: $RUNNER_OS" >&2
    exit 1
    ;;
esac

# shellcheck source=rust/ci/kokoro-env.sh
source "$CI_DIR/kokoro-env.sh" "$KOKORO_CACHE"

cd rust

cargo nextest run --profile ci
