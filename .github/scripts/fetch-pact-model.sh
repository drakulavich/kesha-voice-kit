#!/usr/bin/env bash
# Download the model a signature was recorded from, and refuse anything whose
# sha256 differs. The URL and the digest both come out of the recording, so a
# mirror or an upstream re-upload cannot quietly substitute other weights for
# the pact check (#741) — the same reason models.rs pins every download (#174).
set -euo pipefail

SIGNATURE="${1:?usage: fetch-pact-model.sh <signature.json> <dest>}"
DEST="${2:?}"

url=$(bun --print "JSON.parse(await Bun.file('$SIGNATURE').text()).source_url")
expected=$(bun --print "JSON.parse(await Bun.file('$SIGNATURE').text()).recorded_from_sha256")

if [[ -z "$url" || "$url" == "undefined" || -z "$expected" || "$expected" == "undefined" ]]; then
  echo "error: $SIGNATURE is missing source_url or recorded_from_sha256" >&2
  exit 1
fi

echo "Fetching $url"
curl -fL --retry 3 -o "$DEST.part" "$url"
actual=$(shasum -a 256 "$DEST.part" | cut -d' ' -f1)

if [[ "$actual" != "$expected" ]]; then
  echo "error: sha256 mismatch for $url" >&2
  echo "  recorded: $expected" >&2
  echo "  actual:   $actual" >&2
  echo "The upstream artifact changed. Verify the new weights deliberately (verify-pin-bump)" >&2
  echo "before touching the recording — this check is the reason a swap cannot pass silently." >&2
  rm -f "$DEST.part"
  exit 1
fi

mv "$DEST.part" "$DEST"
echo "sha256 verified: $actual"
