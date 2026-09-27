# Proposal: unified-release

## Why

The CLI (1.29.1 then, 1.32.0 unreleased on `main` now) and the Engine (1.24.11 then, 1.26.0 now) are versioned and tagged independently: bare `vX.Y.Z` for the Engine, `vX.Y.Z-cli` for the CLI, a draft-plus-un-draft gate, and a post-release job that bumps the CLI's Pinned Engine version. Keeping that consistent costs ~1.9k script lines, ~1.6k workflow lines and ~2.2k test lines, spread over 12 workflows and ~20 scripts in four languages; those files are the highest-churn files in the repository. Since mid-May there were 15 Engine and 13 CLI-only releases, often on the same day. An Engine build takes ~9 minutes.

## What Changes

- **One version.** `package.json#version` is the version of both artifacts; `rust/Cargo.toml` mirrors it and `check:versions` keeps them equal. The `keshaEngine.version` field is removed from `package.json`.
- **One stable tag.** `vX.Y.Z` builds the three Engine binaries and Sidecars and the `.deb`/`.rpm`, smoke-tests the Engine assets, publishes the GitHub release with every asset and one merged `SHA256SUMS` in a single step (the repository has immutable releases, so nothing can be attached afterwards), publishes npm with provenance, and updates the tap and Docker — as jobs of one `release.yml`, in dependency order, never through `release: published` events (a `GITHUB_TOKEN`-created release fires none). No draft is left for a person: the smoke on the just-built assets is the gate. Nix needs no job: `flake.nix` reads `package.json#version` at build time.
- **Two Prerelease channels stay.** `-alpha.N` is published per qualifying merge to the default branch (CLI only, no Engine build) or dispatched by a person (Engine and CLI together at one version), and alpha Releases are pruned after 30 days. `-beta.N` is dispatched with a version, builds everything, and publishes as a Prerelease in the same run; it is never pruned. The `-cli` marker and the post-release pin bump are removed.
- **The Engine pin is derived at publish time**, never committed, and carries the asset SHA-256s the installer verifies (#1263), so the committed `PINNED_ASSET_SHA256` table and the post-release PR that rewrote it go away: a stable CLI release resolves the Engine of its own version; a beta resolves the Engine beta of its own version; a per-merge CLI alpha resolves the newest stable Engine without building one; a dispatched alpha resolves the Engine built in the same run, or an Engine Prerelease the dispatcher names.
- **Seven workflows.** `ci.yml` (PR gate, absorbing `rust-test.yml`, `linux-packages.yml`, `cross-os-cache-probe.yml` and Docker's main-push image; `🧪 CI`, `🧪 Rust Tests` and `🛡️ Security Audit` keep their exact job names as required checks), `nightly.yml` (the six schedule-only workflows as jobs), `release.yml`, `security.yml` (absorbing `plugin-security-scan.yml`), and three that stay standalone because folding them would regress a recorded decision: `nix-build.yml`, `cache-seed.yml`, `cache-cleanup.yml` (design D4). `actionlint` joins CI for syntax, expressions and shellcheck; `check-workflows.ts` keeps the pin, timeout, Windows-bash and pipefail policies plus the repository-specific invariants. Scripts move to TypeScript under bun. The alpha publish queue moves with it: `release.yml` runs under a `queue: max` concurrency group, never cancel-in-progress. The per-merge alpha keeps today's `alpha` label gate.
- **npm Trusted Publisher moves to `release.yml`.** npm validates the calling workflow's file name and allows one publisher per package (#732); the maintainer switches it from `npm-publish.yml` to `release.yml` when the PR adding the `npm` job merges. Until the cutover, `npm-publish.yml` stays the only path that publishes.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `release-channels`: a tag names one version of both artifacts; alphas derive their Engine; a dispatched alpha publishes both artifacts together; one publish path is a workflow, not an event chain.
- `installation`: pre-release verification runs on the built assets before publication; Linux packages ship from the same stable tag.

## Impact

`package.json`, `.github/scripts/check-versions.ts`, `.github/workflows/*` (24 → 7), `.github/scripts/*` (62 → ≤25), `packaging/homebrew/Formula/kesha-voice-kit.rb`, `flake.nix:173`, `src/engine-targets.ts` (`PINNED_ASSET_SHA256*`, `sizeBytes`), `src/package-info.ts`, `docs/homebrew.md`, `docs/linux-packages.md`, `docs/release-manifest.md`, `docs/nix-install.md` (merged into `docs/distribution.md`), `openspec/specs/GLOSSARY.md` (`Channel`, `Prerelease`, `Pinned Engine version`), the `release-kesha`, `release-cli` and `release-mechanics` skills (merged into one `release` skill), `.claude/rules/ci-and-build.md` (build rows move to `release.yml`), `tests/unit/*release*`, `tests/integration/alpha-tag.test.ts`, `tests/integration/build-engine-tag-guard.test.ts`, `tests/integration/push-annotated-tag.test.ts`.

## Non-goals

- Changing what any Distribution path installs or where the Model cache lives.
- Removing the alpha or beta channel.
- Changing the engine asset names or the release manifest schema.
