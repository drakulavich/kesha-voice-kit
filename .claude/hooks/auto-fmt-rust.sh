#!/usr/bin/env bash
# PostToolUse hook: auto-format Rust files after Edit/Write/MultiEdit.
#
# Why: Implementer subagents have shipped unformatted Rust mid-session, only
# for clippy --all-targets to fail at the next commit. Catching fmt drift
# right after the edit is cheaper.
#
# Behaviour: silent on no-op (already formatted). On a dirty tree, runs
# `cargo fmt`, prints a one-line note to stderr, exits 0 (non-blocking).

set -euo pipefail

# Read the tool-input JSON from stdin and extract file_path.
PAYLOAD="$(cat || true)"

FILE=""
if command -v jq >/dev/null 2>&1; then
    FILE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)"
fi

# Only act on Rust files under rust/.
case "$FILE" in
    *"/rust/"*.rs|"rust/"*.rs|*.rs)
        # Touched a .rs — proceed.
        ;;
    *)
        exit 0
        ;;
esac

# Need a Cargo.toml at rust/ — defensive (skip if invoked outside the repo).
if [ ! -f "rust/Cargo.toml" ]; then
    exit 0
fi

# Fast path: clean.
if (cd rust && cargo fmt --check >/dev/null 2>&1); then
    exit 0
fi

# Dirty: format and report.
if (cd rust && cargo fmt 2>&1); then
    echo "post-edit hook: cargo fmt auto-formatted rust/ (was dirty)" >&2
    exit 0
else
    echo "post-edit hook: cargo fmt FAILED — investigate manually" >&2
    exit 0  # don't block — model can decide
fi
