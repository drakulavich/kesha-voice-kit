#!/usr/bin/env bash
# A force-push or the first push to a branch leaves BEFORE as all-zeros; fall back to the
# commit's own parent rather than diffing against a ref that does not exist (#685).
set -euo pipefail

if [ -z "${BEFORE:-}" ] || [ "$BEFORE" = "0000000000000000000000000000000000000000" ] \
   || ! git cat-file -e "$BEFORE^{commit}" 2>/dev/null; then
  base="$AFTER^"
else
  base="$BEFORE"
fi

# Status, not just names: a deleted file is gone from the tree, so the packer cannot
# answer for it and it has to be judged differently (#685).
git diff --name-status "$base" "$AFTER" > changed-paths.txt
echo "Changed since ${base}:" >&2
cat changed-paths.txt >&2
