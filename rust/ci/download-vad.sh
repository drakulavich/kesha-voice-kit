#!/usr/bin/env bash
# Stage the pinned Silero VAD (2.3 MB) so the span goldens in
# rust/tests/vad_spans.rs actually run. No lane downloaded this before #990, so
# the VAD had no cross-platform coverage at all.
#
# URL and hash mirror rust/src/models.rs::VAD_FILES; models.rs's
# `ci_download_script_matches_the_pinned_vad_manifest` fails if they drift, so a
# pin bump has to land in both places.
# Wrapped in main() and sourceable — rust/tests/vad_download_script.rs sources this to call sha_of()/verify() directly, cross-platform, without downloading anything (#990 round 2).
set -euo pipefail

URL="https://github.com/snakers4/silero-vad/raw/7e30209a3e901f9842f81b225f3e93d8199902b1/src/silero_vad/data/silero_vad.onnx"
SHA256="1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"

# Hash from stdin: GNU sha256sum escapes a filename containing '\' with a leading '\' on the output line, which Git-Bash's mixed-separator Windows paths trigger (#990 review).
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | cut -d' ' -f1
  else
    shasum -a 256 < "$1" | cut -d' ' -f1
  fi
}

verify() {
  [[ -f "$1" ]] || return 1
  local got
  got="$(sha_of "$1")"
  [[ "$got" == "$SHA256" ]]
}

# vad_download_script.rs overrides these to skip the real backoff on a deliberately corrupted download (#990 round 2).
ATTEMPTS="${DOWNLOAD_VAD_ATTEMPTS:-3}"
RETRY_SECONDS="${DOWNLOAD_VAD_RETRY_SECONDS:-3}"

main() {
  local dest="${1:?usage: download-vad.sh <cache_dir>}"
  local vad_dir="$dest/models/silero-vad"
  local target="$vad_dir/silero_vad.onnx"
  mkdir -p "$vad_dir"

  if verify "$target"; then
    echo "Silero VAD already staged and verified at $target"
    return 0
  fi

  # A restored truncated/stale file is indistinguishable from missing only after hashing, hence the verify-then-delete order rather than trusting what's there.
  rm -f "$target"

  # github.com fails in multi-second bursts a sub-second retry cannot span, so back off in whole seconds.
  for attempt in $(seq 1 "$ATTEMPTS"); do
    echo "Downloading Silero VAD (attempt $attempt)..."
    if curl -fL --retry 2 --retry-delay 2 -o "$target.part" "$URL"; then
      if verify "$target.part"; then
        mv "$target.part" "$target"
        echo "Silero VAD staged at $target"
        return 0
      fi
      echo "sha256 mismatch: expected $SHA256, got $(sha_of "$target.part")" >&2
    fi
    rm -f "$target.part"
    sleep $((attempt * RETRY_SECONDS))
  done

  echo "error: could not stage a verified Silero VAD from $URL" >&2
  return 1
}

if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
  main "$@"
fi
