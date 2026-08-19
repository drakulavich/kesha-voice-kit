# The widened set measures the ANE + diarize surfaces; `system_kokoro` cfg-excludes the ONNX-Kokoro
# ones, so those need a second pass with FEATURES=tts. No recipe measures both — they are exclusive.
FEATURES := "tts,system_kokoro,system_diarize"
ALL := ""
TTS := ""
TTS_FLAG := if TTS == "" { "" } else { "--tts" }
# Two seam_long_form tests cost 60-120 s each and only exercise transcribe/, so every mutant
# outside it pays ~50 s for nothing. TEST_FILTER="" runs everything (nextest rejects an empty
# filterset, so the recipe substitutes all()) — use it when mutating transcribe/ itself.
TEST_FILTER := "not test(seam_long_form)"

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

# Adversarially review this worktree's PR; CLAIM is required because named claims found defects and generic asks did not (#1065)
[positional-arguments]
review CLAIM:
    #!/usr/bin/env bash
    set -euo pipefail
    claim="$1"
    reviewer=${KESHA_REVIEWER:-omc ask grok -p}
    # A detached reviewer that was never on PATH reports itself as launched and is discovered
    # minutes later, in a log holding "command not found" where the findings should be.
    command -v "${reviewer%% *}" >/dev/null || {
      echo "refusing: reviewer '${reviewer%% *}' is not on PATH — install it or set KESHA_REVIEWER" >&2; exit 2; }
    # One read: three separate gh calls can straddle a push and review a head the number never had.
    facts="$(gh pr view --json number,headRefOid,baseRefName -q '"\(.number) \(.headRefOid) \(.baseRefName)"')" || {
      echo "refusing: gh could not read a pull request for this branch (its error is above) — open one first" >&2; exit 2; }
    read -r pr head base <<<"$facts"
    branch="$(git rev-parse --abbrev-ref HEAD)"
    log=".omc/review-${pr}-${head:0:8}.log"
    mkdir -p .omc
    # Truncate rather than remove: review-wait refuses a log that does not exist, and the detached
    # subshell has not necessarily created it by the time this recipe returns.
    rm -f "${log}.status"
    : > "${log}"
    prompt="$(bun scripts/review-prompt.ts "$pr" "$head" "$branch" "$base" "$claim")"
    echo "==> reviewing #${pr} at ${head:0:8}; output -> ${log}"
    # $0 carries the log path so that ${reviewer} keeps the word splitting it needs, and the
    # sentinel is the only signal that separates a finished review from a half-written one.
    nohup bash -c 'set +e; "$@" > "$0" 2>&1; echo $? > "$0.status"' "${log}" ${reviewer} "${prompt}" >/dev/null 2>&1 &
    echo "==> launched in background; block on it with: just review-wait ${log}"
    echo "==> then post the findings as one **grok review** comment carrying the full head SHA"

# Block until `just review` finishes and print its findings once, rather than re-reading a growing log
[positional-arguments]
review-wait LOG:
    bun scripts/review-wait.ts "$@"

# Prove a guard is pinned: replace text, run the tests, restore. Refuses when the text does not occur (#1075)
[positional-arguments]
mutate file find replace +test:
    bun scripts/mutate.ts "$@"

# Earn merge-ready: build SHA-bound evidence for this PR and hand it to the conveyor gate (#1078)
[positional-arguments]
gate issue pr provider uri:
    #!/usr/bin/env bash
    set -euo pipefail
    evidence="$(bun scripts/gate-evidence.ts "$3" "$4" --pr "$2")"
    echo "==> evidence: $evidence"
    bun run conveyor -- gate --issue "$1" --pr "$2" --evidence "$evidence" --apply

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

# Gates are selected from what changed against origin/main...HEAD plus the working tree:
# the Rust gate on rust/, the CoreML check on rust/src/backend/. just ALL=1 preflight forces both.
# The pre-push gate — CLAUDE.md "VERIFY BEFORE PUSHING"
preflight:
    #!/usr/bin/env bash
    set -euo pipefail
    git rev-parse --verify --quiet origin/main >/dev/null || { echo "preflight: no local origin/main to diff against — run: git fetch origin main" >&2; exit 2; }
    # --no-renames: with detection on, a file moved out of rust/ reports only its destination.
    changed="$( { git diff --no-renames --name-only origin/main...HEAD; git diff --no-renames --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u )"
    rust=""; backend=""
    if [ -n "{{ ALL }}" ] || grep -q '^rust/' <<<"$changed"; then rust=1; fi
    if [ -n "{{ ALL }}" ] || grep -q '^rust/src/backend/' <<<"$changed"; then backend=1; fi

    behind="$(git rev-list --count HEAD..origin/main)"
    # A checkout that quietly fell 14 commits behind had an agent reading a stale CLAUDE.md for nine hours (#1070).
    [ "$behind" = "0" ] || echo "==> NOTE: this checkout is $behind commit(s) behind origin/main — read instructions with: git show origin/main:<path>"

    # A green gate's output is never read, and handing it to an agent costs thousands of tokens
    # per run; quiet-gate buffers it and prints it verbatim only when the gate fails.
    gate() { bun scripts/quiet-gate.ts "$1" -- "${@:2}"; }

    echo "==> TS gate (always)"
    gate test bun run test
    gate lint bun run lint
    # tests/unit/preflight-parity.test.ts holds this list equal to what CI runs (#1070).
    gate check:recipes bun run check:recipes
    gate check:workflows bun run check:workflows
    gate check:versions bun run check:versions
    gate check:specs bun run check:specs
    gate check:engine-targets bun run check:engine-targets
    gate check:release-manifest bun run check:release-manifest

    if [ -n "$rust" ]; then
      echo "==> Rust gate"
      # `cargo fmt` formats in place rather than checking, so this can leave a whitespace diff to commit.
      gate clippy bash -c 'cd rust && cargo fmt && cargo clippy --all-targets -- -D warnings'
      gate rust-test {{ just_executable() }} rust-test
    else
      echo "==> Rust gate skipped: no rust/ changes (force with just ALL=1 preflight)"
    fi

    if [ -n "$backend" ]; then
      echo "==> CoreML build check"
      # --all-targets matches rust-test.yml's check so the #[cfg(feature = "coreml")] tests compile too (#708).
      gate coreml bash -c 'cd rust && cargo check --features coreml --no-default-features --all-targets'
    else
      echo "==> CoreML check skipped: no rust/src/backend/ changes"
    fi

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

# `--in-place` is not optional: models.rs include_str!s a file above the crate, so the copy build fails.
# FEATURES and TEST_FILTER stay interpolated: they are set by whoever types the command, while
# FILE is the argument a script or agent passes through.
# Mutation-test one engine file, e.g. just mutants-rust src/errors.rs
[positional-arguments]
mutants-rust FILE:
    @command -v cargo-mutants >/dev/null || { echo "install it: cargo install --locked cargo-mutants" >&2; exit 2; }
    @git diff --quiet -- rust || { echo "rust/ has uncommitted changes; --in-place mutates the tree" >&2; exit 2; }
    cd rust && cargo mutants --in-place -f "$1" --features {{ FEATURES }} -- -E '{{ if TEST_FILTER == "" { "all()" } else { TEST_FILTER } }}'

# Mutation-test TypeScript sources against whichever suites import them, e.g. just mutants-ts src/engine.ts
[positional-arguments]
mutants-ts *FILES:
    bun scripts/mutants-ts.ts "$@"

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
