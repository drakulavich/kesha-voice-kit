#!/usr/bin/env bash
# Pinned release binaries with verified SHA-256s, the same shape as install-nfpm.sh (openspec unified-release D5).
# The shellcheck binary is pinned too: actionlint runs whichever one is first on PATH, and the runner image's 0.9.0
# flagged SC2015 where 0.11.0 does not, so a floating one turns this lane red with no change here.
set -euo pipefail

ACTIONLINT_VERSION="1.7.12"
ACTIONLINT_SHA256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
SHELLCHECK_VERSION="0.11.0"
SHELLCHECK_SHA256="8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198"
DEST="${1:-${RUNNER_TEMP:?RUNNER_TEMP is unset; pass an install dir}/actionlint}"

fetch() {
  local url=$1 sha256=$2 file
  file="$DEST/$(basename "$url")"
  curl -fsSL --retry 3 -o "$file" "$url"
  local actual
  actual=$(shasum -a 256 "$file" | cut -d' ' -f1)
  if [[ "$actual" != "$sha256" ]]; then
    echo "error: sha256 mismatch for $url" >&2
    echo "  pinned: $sha256" >&2
    echo "  actual: $actual" >&2
    rm -f "$file"
    exit 1
  fi
  echo "$file"
}

mkdir -p "$DEST"
archive=$(fetch "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" "$ACTIONLINT_SHA256")
tar -xzf "$archive" -C "$DEST" actionlint
rm "$archive"
archive=$(fetch "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz" "$SHELLCHECK_SHA256")
tar -xJf "$archive" -C "$DEST" --strip-components=1 "shellcheck-v${SHELLCHECK_VERSION}/shellcheck"
rm "$archive"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$DEST" >> "$GITHUB_PATH"
fi
echo "actionlint $ACTIONLINT_VERSION and shellcheck $SHELLCHECK_VERSION installed to $DEST (sha256 verified)"
