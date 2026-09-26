TTS := ""
TTS_FLAG := if TTS == "" { "" } else { "--tts" }

# Show available recipes
default:
    @just --list

# Bootstrap a contributor checkout (checks deps, runs safe local setup)
dev-setup:
    bash scripts/dev-setup.sh

# Both worktree recipes act on the root checkout's worktree list, and `worktree-rm` in particular
# must not run from the tree it is deleting. Only the main working tree has --git-dir equal to
# --git-common-dir; every linked worktree's git dir is a subdirectory of it.
[private]
root-checkout-only:
    #!/usr/bin/env bash
    set -euo pipefail
    common="$(git rev-parse --path-format=absolute --git-common-dir)"
    if [ "$(git rev-parse --path-format=absolute --git-dir)" != "$common" ]; then
      echo "refusing: worktree recipes run from the root checkout, not from inside one — cd $(dirname "$common")" >&2
      exit 2
    fi

# Interpolating this pattern is safe where interpolating a slug is not: it is a justfile literal,
# never a caller's value. It keeps the slug a single path component, so `../..` cannot escape
# .worktrees/ and land an edit surface outside the rule this whole section exists to enforce.
SLUG_PATTERN := "^[A-Za-z0-9][A-Za-z0-9._-]*$"

# `git worktree add -b` refuses an existing branch on its own, so there is no clobber to guard.
# The branch needs no pattern of its own — git rejects a malformed ref name.
# Branch off fresh origin/main into .worktrees/<slug>: just worktree <slug> [branch]
[positional-arguments]
worktree slug branch=slug: root-checkout-only
    #!/usr/bin/env bash
    set -euo pipefail
    [[ "$1" =~ {{ SLUG_PATTERN }} ]] || { echo "refusing: slug must match {{ SLUG_PATTERN }}, got: $1" >&2; exit 2; }
    git fetch origin main
    git worktree add ".worktrees/$1" -b "$2" origin/main
    echo "==> cd .worktrees/$1 — edit, test, commit and open the PR from there"

# Remove a merged worktree and prune its metadata: just worktree-rm <slug>
[positional-arguments]
worktree-rm slug: root-checkout-only
    #!/usr/bin/env bash
    set -euo pipefail
    [[ "$1" =~ {{ SLUG_PATTERN }} ]] || { echo "refusing: slug must match {{ SLUG_PATTERN }}, got: $1" >&2; exit 2; }
    git worktree remove ".worktrees/$1"
    git worktree prune

# Prove a guard is pinned: `just mutate [--timeout S] [--occurrences N] <file> <find> <replace> <test…>` — green baseline, mutate, restore (#1075, #1155, #1211)
[positional-arguments]
mutate +args:
    bun scripts/mutate.ts "$@"

# Run all tests
test:
    bun run test:unit
    bun run test:integration

# Run local checks that mirror the cheap CI gates
check:
    bun run lint
    bun run check:versions
    bun run check:recipes
    {{ just_executable() }} test

# Run Bun coverage and enforce TS coverage gates
coverage-ts:
    bun run coverage:ts
    bun run coverage:check:ts

# Run cargo llvm-cov and enforce Rust coverage gates
coverage-rust:
    bun run coverage:rust
    bun run coverage:check:rust

# "$@" rather than {{ ARGS }}: interpolation is textual, so a filterset's parens would reach sh
# unquoted and be a syntax error — the one nextest argument worth forwarding.
# Run Rust tests via nextest (matches CI — rust-test.yml); args are nextest filters: just rust-test ssml
[positional-arguments]
rust-test *ARGS:
    cd rust && cargo nextest run --features tts "$@"

# Every ignored test in the CoreML modules, with a missing Neural Engine a failure (#841); macOS arm64 after kesha install --tts en
ane-tests:
    cd rust && KESHA_REQUIRE_ANE_TESTS=1 cargo nextest run --no-default-features --features coreml,system_kokoro --run-ignored ignored-only -E 'test(backend::fluidaudio::) + test(streaming_asr::) + test(tts::fluid_kokoro::)'

# #990's VAD session-threading measurement, printed: needs VAD_MODEL staged (kesha install --vad)
vad-bench:
    cd rust && VAD_MODEL="${VAD_MODEL:-$HOME/.cache/kesha/models/silero-vad/silero_vad.onnx}" cargo nextest run --release --features tts --run-ignored ignored-only --no-capture -E 'test(vad_990_measurement)'

# Create and verify a human-authorized stable engine tag. The `api` mode is an explicit fallback
# for an SSH push that cannot be used; it never follows an uncertain push failure automatically.
# Usage: just release-tag vX.Y.Z notes.md [push|api]
[positional-arguments]
release-tag tag notes mode="push": root-checkout-only
    bun scripts/release-tag.ts --tag "$1" --notes "$2" --mode "$3"

# The default nextest run builds only onnx,tts, so system_kokoro / system_diarize /
# system_text_lang never compile locally; rust-test.yml calls this recipe rather than repeat the set.
# Lint the full darwin release feature set (macOS 14+ arm64)
verify-darwin-full:
    cd rust && cargo clippy --all-targets \
        --features coreml,tts,system_tts,system_kokoro,system_diarize,system_text_lang \
        --no-default-features -- -D warnings

# Run smoke tests against fixtures; just TTS=1 smoke-test covers the TTS fixtures too
smoke-test:
    bun link @drakulavich/kesha-voice-kit
    kesha install {{ TTS_FLAG }}
    bun scripts/smoke-test.ts {{ TTS_FLAG }}

# Verify locally before cutting a GitHub release
release-preflight: check smoke-test
    @echo "Release preflight passed. Cut/publish via the GitHub release workflow, not npm publish."

alias release := release-preflight

# Print an existing release body: just release-notes vX.Y.Z
[positional-arguments]
release-notes TAG:
    gh release view "$1" --json body --jq .body
