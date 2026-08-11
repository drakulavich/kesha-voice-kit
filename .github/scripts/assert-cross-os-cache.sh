#!/usr/bin/env bash
# Asserts where a cross-OS cache entry actually extracted, which "Cache restored from key" does not
# tell you: the key can hit while the files land somewhere the consumer never looks (#860).
#
# Usage: assert-cross-os-cache.sh <present|absent> <path> <label>
set -euo pipefail

readonly EXPECTED_CONTENT="kesha-cross-os-probe"
mode="${1:?usage: assert-cross-os-cache.sh <present|absent> <path> <label>}"
path="${2:?missing path}"
label="${3:?missing label}"

case "$mode" in
  present)
    if [ ! -f "$path" ]; then
      echo "FAIL: $label — no probe file at $path" >&2
      echo "  A cross-OS archive stores members relative to GITHUB_WORKSPACE and extracts them the" >&2
      echo "  same way. If a workspace-relative entry no longer lands here, that anchoring changed" >&2
      echo "  and every kesha-models-tts-v3 consumer needs re-checking (#860)." >&2
      exit 1
    fi
    content="$(cat "$path")"
    if [ "$content" != "$EXPECTED_CONTENT" ]; then
      echo "FAIL: $label — probe file at $path holds '$content', expected '$EXPECTED_CONTENT'" >&2
      exit 1
    fi
    echo "ok: $label — probe file present at $path"
    ;;
  absent)
    if [ -f "$path" ]; then
      echo "FAIL: $label — a home-anchored archive DID land at $path" >&2
      echo "  actions/cache documents the opposite: '~' evaluates to an absolute path that does not" >&2
      echo "  match across OSs, so the entry extracts beside the workspace instead. If this is now" >&2
      echo "  false, '~' paths are safe cross-OS and .kesha-ci-cache can be reconsidered (#860)." >&2
      exit 1
    fi
    echo "ok: $label — home-anchored archive did not land at $path, as documented"
    ;;
  *)
    echo "unsupported mode: $mode (expected 'present' or 'absent')" >&2
    exit 2
    ;;
esac
