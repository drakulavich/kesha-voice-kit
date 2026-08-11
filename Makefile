# Compatibility shim over the justfile (#797 Phase 0) — `just` owns the logic now.
# The one-line `bun run …` targets below were never more than bookmarks; they stay
# here verbatim rather than round-tripping through a runner, and Phase 4 deletes them
# along with this file. Everything else delegates, so `just --list` is the one index.

.PHONY: dev-setup install check cli-fast coverage-ts coverage-rust test unit integration rust-test mutants-rust lint versions smoke-test smoke-test-tts benchmark release release-preflight release-notes help

help:
	@just --list

dev-setup:
	just dev-setup

test:
	just test

check:
	just check

coverage-ts:
	just coverage-ts

coverage-rust:
	just coverage-rust

rust-test:
	just rust-test

mutants-rust:
	just $(if $(FILE),FILE='$(FILE)') $(if $(FEATURES),FEATURES='$(FEATURES)') mutants-rust

smoke-test:
	just smoke-test

smoke-test-tts:
	just smoke-test-tts

release-preflight:
	just release-preflight

release:
	just release

release-notes:
	just $(if $(TAG),TAG='$(TAG)') release-notes

# Direct package.json scripts — no justfile recipe exists for these on purpose.
install:
	bun install

cli-fast:
	bun run check

unit:
	bun run test:unit

integration:
	bun run test:integration

lint:
	bunx tsc --noEmit

versions:
	bun .github/scripts/check-versions.ts

benchmark:
	bun scripts/benchmark.ts
