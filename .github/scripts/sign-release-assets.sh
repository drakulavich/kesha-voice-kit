#!/usr/bin/env bash
# Usage: sign-release-assets.sh <asset-dir> — a keyless cosign bundle beside every asset in <asset-dir>.
set -euo pipefail

cd "${1:?usage: sign-release-assets.sh <asset-dir>}"
while IFS= read -r -d '' asset; do
  name="${asset#./}"
  cosign sign-blob --yes --bundle "${name}.sigstore.json" "$name"
done < <(find . -maxdepth 1 -type f ! -name '*.sigstore.json' -print0 | sort -z)
