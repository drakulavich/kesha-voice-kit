# The widened set measures the ANE + diarize surfaces; `system_kokoro` cfg-excludes the ONNX-Kokoro
# ones, so those need a second pass with FEATURES=tts. No recipe measures both — they are exclusive.
FEATURES := "tts,system_kokoro,system_diarize"
FILE := ""
TAG := ""
ALL := ""

# Show available recipes
default:
    @just --list

# Bootstrap a contributor checkout (checks deps, runs safe local setup)
dev-setup:
    bash scripts/dev-setup.sh

# Run all tests
test:
    bun run test:unit
    bun run test:integration

# Run local checks that mirror the cheap CI gates
check:
    bun run lint
    bun run check:versions
    {{ just_executable() }} test

# Run Bun coverage and enforce TS coverage gates
coverage-ts:
    bun run coverage:ts
    bun run coverage:check:ts

# Run cargo llvm-cov and enforce Rust coverage gates
coverage-rust:
    bun run coverage:rust
    bun run coverage:check:rust

# Run Rust tests via nextest (matches CI — rust-test.yml)
rust-test:
    cd rust && cargo nextest run --features tts

# Gates are selected from what changed against origin/main...HEAD plus the working tree:
# the Rust gate on rust/, the CoreML check on rust/src/backend/. just ALL=1 preflight forces both.
# The pre-push gate — CLAUDE.md "VERIFY BEFORE PUSHING"
preflight:
    #!/usr/bin/env bash
    set -euo pipefail
    git rev-parse --verify --quiet origin/main >/dev/null || { echo "preflight: no local origin/main to diff against — run: git fetch origin main" >&2; exit 2; }
    changed="$( { git diff --name-only origin/main...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u )"
    rust=""; backend=""
    if [ -n "{{ ALL }}" ] || grep -q '^rust/' <<<"$changed"; then rust=1; fi
    if [ -n "{{ ALL }}" ] || grep -q '^rust/src/backend/' <<<"$changed"; then backend=1; fi

    echo "==> TS gate (always)"
    bun run test
    bun run lint

    if [ -n "$rust" ]; then
      echo "==> Rust gate"
      # `cargo fmt` formats in place rather than checking, so this can leave a whitespace diff to commit.
      (cd rust && cargo fmt && cargo clippy --all-targets -- -D warnings)
      {{ just_executable() }} rust-test
    else
      echo "==> Rust gate skipped: no rust/ changes (force with just ALL=1 preflight)"
    fi

    if [ -n "$backend" ]; then
      echo "==> CoreML build check"
      (cd rust && cargo check --features coreml --no-default-features)
    else
      echo "==> CoreML check skipped: no rust/src/backend/ changes"
    fi

# The default nextest run builds only onnx,tts, so system_kokoro / system_diarize /
# system_text_lang never compile locally; rust-test.yml calls this recipe rather than repeat the set.
# Lint the full darwin release feature set (macOS 14+ arm64)
verify-darwin-full:
    cd rust && cargo clippy --all-targets \
        --features coreml,tts,system_tts,system_kokoro,system_diarize,system_text_lang \
        --no-default-features -- -D warnings

# `--in-place` is not optional: models.rs include_str!s a file above the crate, so the copy build fails.
# Mutation-test one engine file, e.g. just FILE=src/errors.rs mutants-rust
mutants-rust:
    @test -n "{{ FILE }}" || { echo "usage: just FILE=src/<file>.rs [FEATURES=<set>] mutants-rust" >&2; exit 2; }
    @command -v cargo-mutants >/dev/null || { echo "install it: cargo install --locked cargo-mutants" >&2; exit 2; }
    @git diff --quiet -- rust || { echo "rust/ has uncommitted changes; --in-place mutates the tree" >&2; exit 2; }
    cd rust && cargo mutants --in-place -f {{ FILE }} --features {{ FEATURES }}

# Run smoke tests against fixtures
smoke-test:
    bun link @drakulavich/kesha-voice-kit
    kesha install
    bun scripts/smoke-test.ts

# Run smoke tests with TTS
smoke-test-tts:
    bun link @drakulavich/kesha-voice-kit
    kesha install --tts
    bun scripts/smoke-test.ts --tts

# Verify locally before cutting a GitHub release
release-preflight: check smoke-test
    @echo "Release preflight passed. Cut/publish via the GitHub release workflow, not npm publish."

alias release := release-preflight

# Print an existing release body: just TAG=vX.Y.Z release-notes
release-notes:
    @test -n "{{ TAG }}" || { echo "usage: just TAG=vX.Y.Z release-notes" >&2; exit 2; }
    gh release view "{{ TAG }}" --json body --jq .body
