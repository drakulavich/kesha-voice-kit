# The widened set measures the ANE + diarize surfaces; `system_kokoro` cfg-excludes the ONNX-Kokoro
# ones, so those need a second pass with FEATURES=tts. No recipe measures both — they are exclusive.
FEATURES := "tts,system_kokoro,system_diarize"
FILE := ""
TAG := ""

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
