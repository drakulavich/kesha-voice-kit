## Context

Tags today: `release-tags.mjs:11-39` (`vX.Y.Z`, `-beta.N`, `-alpha.N`, `-cli` marker). Draft/un-draft: `classify-release-tag.mjs:5-10`. Pin refusal for alphas: `check-versions.ts:82-91`. Event-triggered downstream: `npm-publish.yml:18-20`, `homebrew-tap.yml:3-5`, `post-engine-release.yml:3-5`; explicit dispatch workaround: `dispatch-npm-publish.sh:15`. Linux packages keyed on the `-cli` marker: `linux-packages.yml:43`. Docker excludes alphas: `docker.yml:6`. Nix writes an Engine version marker from `package.json#keshaEngine.version`: `flake.nix:173`.

## Goals / Non-Goals

Goals: one number to bump; one workflow to read; no event cascade to reason about; alphas keep rehearsing the path. Non-goals: as in the proposal.

## Decisions

### D1. Version and pin

`package.json#version` is the only version. The CLI resolves its Engine as: stable `X.Y.Z` → Engine `vX.Y.Z`; beta `X.Y.Z-beta.N` → Engine `vX.Y.Z-beta.N`; alpha `X.Y.Z-alpha.N` → the newest stable Engine tag at publish time unless the dispatcher passes `engine-prerelease: vX.Y.Z-beta.N`. The resolution is written into the published package (`package.json#kesha.engine` at publish, injected the way alpha versions are injected today) and never committed to `main`. `check:versions` rule 3 becomes: `main` carries no pin field at all.

Why not build an Engine per CLI alpha: `release-channels` requires Engine alphas to be deliberate, and 4 merges a day × 9 min × 3 runners is real money for a rehearsal that changes no Engine bytes.

### D2. `release.yml`

Triggered by `push: tags: [v*]` and `workflow_dispatch` (alpha with an explicit `engine-prerelease`). Jobs: `classify` (tag → channel; refuses any tag not matching `^v\d+\.\d+\.\d+(-(alpha|beta)\.\d+)?$`), `build-engine` (matrix of two profiles), `smoke` (downloads the just-built assets as artifacts, runs `describe`, `say`, `transcribe` round-trip per platform), `github-release` (draft for stable and beta, published for alpha), `npm` (`workflow_call` into the publish job with provenance; skipped for beta), `packages` (`.deb`/`.rpm`, stable only), `homebrew`, `docker`, `nix-version`. Every downstream job `needs:` its upstream; nothing subscribes to `release:` events. Stable and beta stay draft until a person un-drafts; the assets were already smoke-tested, so un-drafting is a publication decision, not a validation step.

### D3. Alpha and beta

Alpha keeps `release-alpha.yml`'s derivation logic (`derive-alpha-version.ts`, `alpha-publishable.ts`) as jobs inside `release.yml` on `push` to `main`; the derived version is `X.Y.Z-alpha.N` and the Engine pin follows D1. Beta is dispatched with a version and builds the Engine; it is the carrier for the v2 migration (design spec section 4) and is never pruned.

### D4. `nightly.yml`

Jobs: `capability-pact`, `cargo-dependency-maintenance`, `mini-model-pact`, `model-plan-size-canary`, `prune-alpha-releases`, `real-model-canary`, each with the schedule and permissions it has today, each independently dispatchable through a `job` input.

### D5. Lint

`actionlint` runs in `ci.yml` and owns pinned action SHAs, shell selection, timeouts and expression syntax; `check-workflows.ts` keeps `requirePactVerificationCoversEveryTarget`, `requireRestoreOnlyCachesHaveAWriter`, `requireNpmPublishAfterPackaging` and the profile-row assertion from `build-profiles`.

## Risks / Trade-offs

- A CLI-only fix now rebuilds the Engine (~9 min, ~190 MB re-uploaded). Accepted.
- An Engine hotfix is also a CLI release. Accepted; one CHANGELOG stream.
- Deleting twelve workflows in one PR is unreviewable; one workflow per PR.

## Migration Plan

Stage 4, 8–12 PRs after `core-api-v2`: `release.yml` skeleton with `classify` + `build-engine` + `smoke`; then npm; then packages/tap/docker/nix; then alpha derivation moves in; then one deletion PR per old workflow; then `nightly.yml`; then `actionlint` + `check-workflows.ts` cut; then docs and skills; then tag `v2.0.0`.

## Open Questions

- Whether Homebrew's formula should install the Engine too (today it installs the CLI from the tag tarball and the CLI downloads the Engine on `kesha install`). Out of scope; the formula changes only its version source.
