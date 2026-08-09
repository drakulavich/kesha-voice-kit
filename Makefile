.PHONY: dev-setup install check cli-fast coverage-ts coverage-rust test unit integration rust-test lint versions smoke-test smoke-test-tts benchmark release release-preflight release-notes help

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

dev-setup: ## Bootstrap a contributor checkout (checks deps, runs safe local setup)
	bash scripts/dev-setup.sh

install: ## Install dependencies
	bun install

test: unit integration ## Run all tests

check: lint versions test ## Run local checks that mirror the cheap CI gates

cli-fast: ## Run deterministic CLI checks without engine-backed E2E lanes
	bun run check

coverage-ts: ## Run Bun coverage and enforce TS coverage gates
	bun run coverage:ts
	bun run coverage:check:ts

coverage-rust: ## Run cargo llvm-cov and enforce Rust coverage gates
	bun run coverage:rust
	bun run coverage:check:rust

unit: ## Run unit tests
	bun run test:unit

integration: ## Run integration tests
	bun run test:integration

rust-test: ## Run Rust tests via nextest (matches CI — rust-test.yml)
	cd rust && cargo nextest run --features tts

# The widened set measures the ANE + diarize surfaces; `system_kokoro` cfg-excludes the ONNX-Kokoro
# ones, so those need a second pass with FEATURES=tts. No target measures both — they are exclusive.
FEATURES ?= tts,system_kokoro,system_diarize

# `--in-place` is not optional: models.rs include_str!s a file above the crate, so the copy build fails.
mutants-rust: ## Mutation-test one engine file, e.g. make mutants-rust FILE=src/errors.rs [FEATURES=tts]
	@test -n "$(FILE)" || { echo "usage: make mutants-rust FILE=src/<file>.rs [FEATURES=<set>]" >&2; exit 2; }
	@command -v cargo-mutants >/dev/null || { echo "install it: cargo install --locked cargo-mutants" >&2; exit 2; }
	@git diff --quiet -- rust || { echo "rust/ has uncommitted changes; --in-place mutates the tree" >&2; exit 2; }
	cd rust && cargo mutants --in-place -f $(FILE) --features $(FEATURES)

lint: ## Type-check with tsc
	bunx tsc --noEmit

versions: ## Check version drift between package.json + Cargo.toml (#267 F16)
	bun .github/scripts/check-versions.ts

smoke-test: ## Run smoke tests against fixtures
	bun link @drakulavich/kesha-voice-kit
	kesha install
	bun scripts/smoke-test.ts

smoke-test-tts: ## Run smoke tests with TTS
	bun link @drakulavich/kesha-voice-kit
	kesha install --tts
	bun scripts/smoke-test.ts --tts

benchmark: ## Run benchmark (openai-whisper vs faster-whisper vs Kesha)
	bun scripts/benchmark.ts

release-preflight: check smoke-test ## Verify locally before cutting a GitHub release
	@echo "Release preflight passed. Cut/publish via the GitHub release workflow, not npm publish."

release: release-preflight ## Backward-compatible alias for release-preflight

release-notes: ## Print an existing release body: make release-notes TAG=vX.Y.Z
	@test -n "$(TAG)" || (echo "usage: make release-notes TAG=vX.Y.Z" >&2; exit 2)
	gh release view "$(TAG)" --json body --jq .body
