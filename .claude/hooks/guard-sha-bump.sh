#!/usr/bin/env bash
# PreToolUse hook: refuse silent SHA-256 pin bumps in rust/src/models.rs.
#
# Why: CLAUDE.md "MODEL HASHES ARE PINNED". Incident #174 was a regression
# where verification was disabled silently. This hook blocks edits that
# CHANGE an existing sha256 value without a justification comment in the
# new content (e.g. `// bumped: upstream re-export <hf-commit>`).
#
# Allows:
#   - Adding new ModelFile entries (no old sha256 was changed)
#   - Pure non-sha256 edits (rename, doc tweak)
#   - SHA bumps that include a justification keyword on/near the changed line
#
# Blocks (exit 2 → tool refused, model sees stderr):
#   - SHA value changed AND new content has no justification keyword
#
# Justification keywords (case-insensitive):
#   bumped | re-export | reexport | upstream | new model | model version | hf commit | re-pinned

set -euo pipefail

# jq is required for reliable JSON parsing; if missing, fail-open.
if ! command -v jq >/dev/null 2>&1; then
    exit 0
fi

PAYLOAD="$(cat || true)"
TOOL="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty')"
FILE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // .tool_input.path // empty')"

# Only guard rust/src/models.rs (any abs path resolving to it).
case "$FILE" in
    */rust/src/models.rs|rust/src/models.rs)
        ;;
    *)
        exit 0
        ;;
esac

# Collect every old_string + new_string from this Edit/Write/MultiEdit call.
OLD_TEXT=""
NEW_TEXT=""

case "$TOOL" in
    Edit)
        OLD_TEXT="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.old_string // ""')"
        NEW_TEXT="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.new_string // ""')"
        ;;
    MultiEdit)
        OLD_TEXT="$(printf '%s' "$PAYLOAD" | jq -r '[.tool_input.edits[]?.old_string] | join("\n")')"
        NEW_TEXT="$(printf '%s' "$PAYLOAD" | jq -r '[.tool_input.edits[]?.new_string] | join("\n")')"
        ;;
    Write)
        # Full overwrite — compare against current file on disk.
        if [ -f "$FILE" ]; then
            OLD_TEXT="$(cat "$FILE")"
        fi
        NEW_TEXT="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.content // ""')"
        ;;
    *)
        exit 0
        ;;
esac

# Extract sha256 hex values (64 hex chars) from each side. Portable for bash 3.2.
OLD_SHAS_NL="$(printf '%s' "$OLD_TEXT" | grep -oE '[0-9a-f]{64}' | sort -u || true)"
NEW_SHAS_NL="$(printf '%s' "$NEW_TEXT" | grep -oE '[0-9a-f]{64}' | sort -u || true)"

# Find SHAs that vanished (i.e. were CHANGED, not just added).
REMOVED=""
REMOVED_COUNT=0
if [ -n "$OLD_SHAS_NL" ]; then
    while IFS= read -r s; do
        [ -z "$s" ] && continue
        if ! printf '%s\n' "$NEW_SHAS_NL" | grep -qx "$s"; then
            REMOVED="${REMOVED}${s}\n"
            REMOVED_COUNT=$((REMOVED_COUNT + 1))
        fi
    done <<< "$OLD_SHAS_NL"
fi

# No SHAs removed → either a pure addition or no sha touch — allow.
if [ "$REMOVED_COUNT" -eq 0 ]; then
    exit 0
fi

# At least one sha was changed. Demand a justification keyword in the new content.
JUSTIFY_RE='([Bb]umped|[Rr]e-?export|[Uu]pstream|[Nn]ew model|model version|hf commit|[Rr]e-?pinned)'
if printf '%s' "$NEW_TEXT" | grep -qE "$JUSTIFY_RE"; then
    exit 0
fi

# No justification — block.
cat >&2 <<EOF
🛑 guard-sha-bump.sh: refusing silent SHA-256 bump in rust/src/models.rs.

You changed ${REMOVED_COUNT} pinned SHA(s):
$(printf "$REMOVED" | sed 's/^/  - /')

Per CLAUDE.md "MODEL HASHES ARE PINNED" + incident #174, every bump must be
deliberate. Add a justification comment on or near the changed line, e.g.:

    // bumped: upstream re-export at hf commit a1b2c3d (tokenizer fix)

OR run the verify-pin-bump skill which walks the safe procedure end-to-end.

Refusing this Edit. Update new_string with a justification keyword
(bumped | re-export | upstream | new model | hf commit | re-pinned)
or invoke /verify-pin-bump first.
EOF
exit 2
