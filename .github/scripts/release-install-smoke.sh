#!/usr/bin/env bash
# Exercise only distributed artifacts in a private scratch directory.  A draft asset cannot be
# fetched through its public URL, so the draft mode deliberately uses authenticated `gh release
# download`; the npm mode deliberately uses the registry package, never this checkout's binary.
set -euo pipefail

mode=${1:?usage: release-install-smoke.sh <draft-engine|npm>}
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

run_draft_engine() {
  require TAG
  require ENGINE_VERSION

  [ "$(gh release view "$TAG" --json isDraft --jq .isDraft)" = "true" ] ||
    fail "$TAG is no longer a draft; draft verification must finish before undrafting"

  local asset=kesha-engine-linux-x64
  local assets="$scratch/assets"
  mkdir -p "$assets"
  gh release download "$TAG" --repo drakulavich/kesha-voice-kit \
    --pattern "$asset" --pattern SHA256SUMS --dir "$assets"

  (
    cd "$assets"
    sha256sum --ignore-missing --check SHA256SUMS
  )
  [ -s "$assets/$asset" ] || fail "draft $TAG did not provide a non-empty $asset"
  chmod 755 "$assets/$asset"

  local actual_version
  actual_version=$("$assets/$asset" --version)
  [ "$actual_version" = "kesha-engine $ENGINE_VERSION" ] ||
    fail "draft binary version was '$actual_version', expected 'kesha-engine $ENGINE_VERSION'"

  "$assets/$asset" describe > "$scratch/describe.json"
  jq -e '.protocolVersion == 4 and .backend == "onnx" and (.features | index("tts"))' "$scratch/describe.json" >/dev/null ||
    fail "draft Linux engine does not describe protocol 4 with onnx + tts"

  # This is the marker `kesha install` writes after its normal download.  We stage the authenticated
  # draft asset at that final location so the CLI can perform the user-facing model install without
  # attempting an anonymous (and necessarily 404) re-download of the same draft.
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

  echo "draft-engine smoke passed: tag=$TAG engine=$ENGINE_VERSION artifact=$asset"
}

run_npm() {
  require VERSION

  local package=@drakulavich/kesha-voice-kit
  local prefix="$scratch/npm-prefix"
  local metadata="$scratch/npm-metadata.json"
  export npm_config_cache="$scratch/npm-cache"
  export NPM_CONFIG_PREFIX="$prefix"

  npm view "$package@$VERSION" --json version,dist.integrity,dist.attestations > "$metadata"
  jq -e --arg version "$VERSION" '
    .version == $version
    and (.dist.integrity | type == "string" and startswith("sha512-"))
    and (.dist.attestations.provenance.predicateType == "https://slsa.dev/provenance/v1")
  ' "$metadata" >/dev/null ||
    fail "npm metadata for $package@$VERSION lacks the expected version, integrity, or provenance"

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
  draft-engine) run_draft_engine ;;
  npm) run_npm ;;
  *) fail "unsupported smoke mode: $mode" ;;
esac
