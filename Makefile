# Compatibility shim over the justfile (#797 Phase 0) — `just` owns the logic now.
# The one-line `bun run …` targets below were never more than bookmarks; they stay
# here verbatim rather than round-tripping through a runner, and Phase 4 deletes them
# along with this file. Everything else delegates, so `just --list` is the one index.

.PHONY: need-just dev-setup install check cli-fast coverage-ts coverage-rust test unit integration rust-test mutants-rust lint versions smoke-test smoke-test-tts benchmark release release-preflight release-notes help

# Without this, a checkout lacking just gets a bare "make: just: No such file or directory".
need-just:
	@command -v just >/dev/null || { echo "just is required for this target: cargo install --locked just" >&2; exit 2; }

help: need-just
	@just --list

dev-setup: need-just
	just dev-setup

test: need-just
	just test

check: need-just
	just check

coverage-ts: need-just
	just coverage-ts

coverage-rust: need-just
	just coverage-rust

# make cannot forward a trailing filter (it reads one as another goal) — use `just rust-test <filter>`.
rust-test: need-just
	just rust-test

mutants-rust: need-just
	just $(if $(FEATURES),FEATURES='$(FEATURES)') mutants-rust $(FILE)

smoke-test: need-just
	just smoke-test

smoke-test-tts: need-just
	just TTS=1 smoke-test

release-preflight: need-just
	just release-preflight

release: need-just
	just release

release-notes: need-just
	just release-notes $(TAG)

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
