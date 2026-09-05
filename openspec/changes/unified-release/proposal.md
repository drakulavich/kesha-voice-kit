# Proposal: unified-release

## Why

The CLI (1.29.1) and the Engine (1.24.11) are versioned and tagged independently: bare `vX.Y.Z` for the Engine, `vX.Y.Z-cli` for the CLI, a draft-plus-un-draft gate, and a post-release job that bumps the CLI's Pinned Engine version. Keeping that consistent costs ~1.9k script lines, ~1.6k workflow lines and ~2.2k test lines, spread over 12 workflows and ~20 scripts in four languages; those files are the highest-churn files in the repository. Since mid-May there were 15 Engine and 13 CLI-only releases, often on the same day. An Engine build takes ~9 minutes.

## What Changes

- **One version.** `package.json#version` is the version of both artifacts; `rust/Cargo.toml` mirrors it and `check:versions` keeps them equal. The `keshaEngine.version` field is removed from `package.json`.
- **One stable tag.** `vX.Y.Z` builds the three Engine binaries and Sidecars, smoke-tests each asset, creates the GitHub release, publishes npm with provenance, and updates the tap, `.deb`/`.rpm`, Docker and the Nix version file — as jobs of one `release.yml`, in dependency order, never through `release: published` events (a `GITHUB_TOKEN`-created release fires none).
- **Two Prerelease channels stay.** `-alpha.N` (auto-published per qualifying merge, pruned after 30 days) and `-beta.N` (dispatched, draft, un-drafted by hand, never pruned, and the only Prerelease the CLI may pin as its Engine). The `-cli` marker and the post-release pin bump are removed.
- **The Engine pin is derived at publish time**, never committed: a stable CLI release resolves the Engine of its own version; a CLI alpha resolves the newest stable Engine, or the Engine Prerelease named by the dispatcher; a CLI beta resolves the Engine beta of the same version.
- **Four workflows.** `ci.yml` (PR gate; `🧪 CI`, `🧪 Rust Tests` and `🛡️ Security Audit` keep their names as required checks), `nightly.yml` (the six schedule-only workflows as jobs), `release.yml`, `security.yml`. `actionlint` joins CI; `check-workflows.ts` keeps only repository-specific invariants. Scripts move to TypeScript under bun.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `release-channels`: a tag names one version of both artifacts; alphas derive their Engine; one publish path is a workflow, not an event chain.
- `installation`: pre-release verification runs on the built assets before publication; Linux packages ship from the same stable tag.

## Impact

`package.json`, `.github/scripts/check-versions.ts`, `.github/workflows/*` (23 → 4), `.github/scripts/*` (60 → ≤25), `packaging/homebrew/Formula/kesha-voice-kit.rb`, `flake.nix:173`, `docs/homebrew.md`, `docs/linux-packages.md`, `docs/release-manifest.md`, `docs/nix-install.md` (merged into `docs/distribution.md`), the `release-engine`, `release-cli` and `release-mechanics` skills (merged into one `release` skill), `CLAUDE.md` Releases section, `tests/unit/*release*`, `tests/integration/alpha-tag.test.ts`, `build-engine-tag-guard.test.ts`, `push-annotated-tag.test.ts`.

## Non-goals

- Changing what any Distribution path installs or where the Model cache lives.
- Removing the alpha or beta channel.
- Changing the engine asset names or the release manifest schema.
