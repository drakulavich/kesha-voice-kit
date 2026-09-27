#!/usr/bin/env bash
# Exercise only distributed artifacts in a private scratch directory: the artifact mode takes the
# just-built workflow artifact, the npm mode the registry package, never this checkout's binary.
set -euo pipefail

mode=${1:?usage: release-install-smoke.sh <artifact|npm>}
repo_root=${GITHUB_WORKSPACE:-$PWD}
scratch_base=${RUNNER_TEMP:-/tmp}
scratch=$(mktemp -d "$scratch_base/kesha-release-install-smoke.XXXXXX")

cleanup() {
  rm -rf -- "$scratch"
}
trap cleanup EXIT

fail() {
  echo "::error::$*" >&2
  exit 1
}

require() {
  local name=$1
  [ -n "${!name:-}" ] || fail "$name must be set"
}

verify_engine_asset() {
  local assets=$1 asset=$2
  [ -s "$assets/$asset" ] || fail "$assets/$asset is missing or empty"
  chmod 755 "$assets/$asset"

  local actual_version
  actual_version=$("$assets/$asset" --version)
  [ "$actual_version" = "kesha-engine $ENGINE_VERSION" ] ||
    fail "engine binary version was '$actual_version', expected 'kesha-engine $ENGINE_VERSION'"

  "$assets/$asset" describe > "$scratch/describe.json"
  jq -e '.protocolVersion == 4 and .backend == "onnx" and (.features | index("tts"))' "$scratch/describe.json" >/dev/null ||
    fail "Linux engine does not describe protocol 4 with onnx + tts"

  # This is the marker `kesha install` writes after its normal download.  Staging the artifact at that
  # final location lets the CLI perform the user-facing model install without downloading an engine
  # that is not published yet.
  printf '%s\n' "$ENGINE_VERSION" > "$assets/$asset.version"
  export KESHA_ENGINE_BIN="$assets/$asset"
  export KESHA_CACHE_DIR="$scratch/cache"
  export KESHA_COMMAND="$repo_root/bin/kesha.js"

  "$KESHA_COMMAND" --version
  "$KESHA_COMMAND" install --onnx --tts en 2>&1 | tee "$scratch/install.log"
  bun "$repo_root/.github/scripts/assert-install-warmup.ts" "$scratch/install.log"
  "$KESHA_COMMAND" --json "$repo_root/tests/fixtures/benchmark-en/01-check-email.ogg" > "$scratch/transcript.json"
  bun "$repo_root/.github/scripts/assert-transcript.ts" "$scratch/transcript.json"
  bun "$repo_root/.github/scripts/smoke-synthesis.ts" "$scratch/synthesis"
}

# The just-built workflow artifact, before any release exists: nothing is downloaded but models.
run_artifact() {
  require ASSET_DIR
  require ENGINE_VERSION
  verify_engine_asset "$ASSET_DIR" kesha-engine-linux-x64
  echo "artifact smoke passed: engine=$ENGINE_VERSION"
}

run_npm() {
  require VERSION

  local package=@drakulavich/kesha-voice-kit
  local prefix="$scratch/npm-prefix"
  export npm_config_cache="$scratch/npm-cache"
  export NPM_CONFIG_PREFIX="$prefix"

  bun "$repo_root/.github/scripts/npm-release-metadata.ts" "$package" "$VERSION"

  npm install --global "$package@$VERSION"
  local kesha="$prefix/bin/kesha"
  [ -x "$kesha" ] || fail "npm installed $package@$VERSION without the kesha executable"

  local installed_version
  installed_version=$(node -p "require('$prefix/lib/node_modules/$package/package.json').version")
  [ "$installed_version" = "$VERSION" ] ||
    fail "installed npm package version was $installed_version, expected $VERSION"
  "$kesha" --version | grep -F "$VERSION" >/dev/null ||
    fail "installed kesha CLI did not report version $VERSION"

  export KESHA_CACHE_DIR="$scratch/cache"
  "$kesha" install --onnx 2>&1 | tee "$scratch/install.log"
  bun "$repo_root/.github/scripts/assert-install-warmup.ts" "$scratch/install.log"
  "$kesha" --json "$repo_root/tests/fixtures/benchmark-en/01-check-email.ogg" > "$scratch/transcript.json"
  bun "$repo_root/.github/scripts/assert-transcript.ts" "$scratch/transcript.json"

  echo "npm smoke passed: package=$package version=$VERSION"
}

case "$mode" in
  artifact) run_artifact ;;
  npm) run_npm ;;
  *) fail "unsupported smoke mode: $mode" ;;
esac
