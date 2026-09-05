## Context

Tags today: `release-tags.mjs:11-39` (`vX.Y.Z`, `-beta.N`, `-alpha.N`, `-cli` marker). Draft/un-draft: `classify-release-tag.mjs:5-10`. Pin refusal for alphas: `check-versions.ts:82-91`. Event-triggered downstream: `npm-publish.yml:18-20`, `homebrew-tap.yml:3-5`, `post-engine-release.yml:3-5`; explicit dispatch workaround: `dispatch-npm-publish.sh:15`. Linux packages keyed on the `-cli` marker: `linux-packages.yml:43`. Docker excludes alphas: `docker.yml:6`. Nix writes an Engine version marker from `package.json#keshaEngine.version`: `flake.nix:173`.

## Goals / Non-Goals

Goals: one number to bump; one workflow to read; no event cascade to reason about; alphas keep rehearsing the path. Non-goals: as in the proposal.

## Decisions

### D1. Version and pin

`package.json#version` is the only version. The CLI resolves its Engine as: stable `X.Y.Z` → Engine `vX.Y.Z`; beta `X.Y.Z-beta.N` → Engine `vX.Y.Z-beta.N`; alpha `X.Y.Z-alpha.N` published from a `main` push → the newest stable Engine tag at publish time; alpha dispatched by a person → the Engine built in that same run, or the Engine Prerelease named by `engine-prerelease`, which skips the build. The resolution is written into the published package (`package.json#kesha.engine` at publish, injected the way alpha versions are injected today) and never committed to `main`. `check:versions` rule 3 becomes: `main` carries no pin field at all.

Why not build an Engine per per-merge CLI alpha: `release-channels` requires Engine alphas to be deliberate, and 4 merges a day × 9 min × 3 runners is real money for a rehearsal that changes no Engine bytes. A person who wants the Engine alpha dispatches one, and then both artifacts publish together at that version.

### D2. `release.yml`

Triggered by `push` to tags matching `v*` but not `v*-alpha.*`, `push` to `main` (the per-merge CLI alpha path), and `workflow_dispatch` (a beta with a version; or an alpha, which builds the Engine in the same run, or names an existing Engine Prerelease through `engine-prerelease` and skips the build). Alpha tags are recorded by the alpha jobs after they publish and never act as triggers, which is why the tag filter excludes their shape — a recorded tag that re-entered the workflow would publish the same version twice.

`classify` decides the path from the event and refuses any tag not matching `^v\d+\.\d+\.\d+(-(alpha|beta)\.\d+)?$`. A tag or a dispatch runs the release path (`stable`, `beta` or `alpha`); a `main` push runs the alpha derivation (`cli-alpha`), which skips `build-engine`, `smoke`, `packages`, `homebrew`, `docker` and `nix-version` (`if: needs.classify.outputs.path != 'cli-alpha'`) because a per-merge alpha changes no Engine bytes and resolves an existing Engine per D1 — the trigger tells the paths apart, so no `-cli` marker is needed.

Jobs: `classify`, `build-engine` (matrix of two profiles), `smoke` (downloads the just-built assets as artifacts, runs `describe`, `say`, `transcribe` round-trip per platform), `github-release`, `npm`, `packages` (`.deb`/`.rpm`), `homebrew`, `docker`, `nix-version`. Every downstream job `needs:` its upstream; nothing subscribes to `release:` events.

`github-release` publishes immediately and drafts nothing: a stable release is published as Latest, a beta and a dispatched alpha as a Prerelease, in the same run that built and smoked the assets. The smoke on the just-built assets is the gate, so there is nothing a manual un-draft would add. A `cli-alpha` creates no GitHub Release at all; it records its tag and publishes to npm. `npm`, `packages`, `homebrew`, `docker` and `nix-version` all `needs: github-release`, so a published CLI can never resolve an Engine that is still a draft.

`npm` publishes on every path with provenance, choosing the dist-tag from the channel: `latest` for stable, `beta` for a beta, `alpha` for either kind of alpha. `packages`, `homebrew`, `docker` and `nix-version` run for stable only. Shared steps live in composite actions under `.github/actions/`; no reusable workflow (`workflow_call`) is used, because each would be a separate file and the four-workflow target counts files.

### D3. Alpha and beta

Alpha keeps `release-alpha.yml`'s derivation logic (`derive-alpha-version.ts`, `alpha-publishable.ts`) as jobs inside `release.yml` on `push` to `main`; the derived version is `X.Y.Z-alpha.N`, the Engine resolution follows D1, and the Engine-building jobs are skipped on that path (D2). A dispatched alpha is the deliberate Engine alpha of `release-channels`: it builds the Engine, publishes it as a Prerelease and publishes the CLI to npm at the same version, so both artifacts appear together.

Beta is dispatched with a version, builds the Engine, publishes a GitHub Prerelease in the same run and reaches npm on the `beta` dist-tag; it is never a draft and is never pruned. Beta is also the carrier for the v2 migration (design spec section 4) — but that carrier ships in stages 1–3, under the old machinery, where a beta really is a draft un-drafted by hand. `release.yml` lands in stage 4, after the migration it carried is over.

### D4. `nightly.yml`

Jobs: `capability-pact`, `cargo-dependency-maintenance`, `mini-model-pact`, `model-plan-size-canary`, `prune-alpha-releases`, `real-model-canary`, each with the schedule and permissions it has today, each independently dispatchable through a `job` input.

### D5. Lint

`actionlint` runs in `ci.yml` and owns workflow syntax, expression typing and shellcheck of `run:` blocks. `check-workflows.ts` keeps the policies actionlint does not enforce — `requirePinnedActions`, `requireJobTimeouts`, `requireBashOnWindowsRunSteps`, `requirePipefailShell` — plus `requirePactVerificationCoversEveryTarget`, `requireRestoreOnlyCachesHaveAWriter`, `requireNpmPublishAfterPackaging` and the profile-row assertion from `build-profiles`; it loses the rules actionlint covers (`forbidFindPipedToHead` stays only if shellcheck does not flag it).

## Risks / Trade-offs

- A CLI-only fix now rebuilds the Engine (~9 min, ~190 MB re-uploaded). Accepted.
- An Engine hotfix is also a CLI release. Accepted; one CHANGELOG stream.
- Publishing without a draft step removes the last manual gate before a release is visible. Accepted because the smoke runs on the just-built assets first, which the draft flow never did.
- Deleting twelve workflows in one PR is unreviewable; one workflow per PR.

## Migration Plan

Stage 4, 8–12 PRs after `core-api-v2`: `release.yml` skeleton with `classify` + `build-engine` + `smoke`; then npm; then packages/tap/docker/nix; then alpha derivation moves in; then one deletion PR per old workflow; then `nightly.yml`; then `actionlint` + `check-workflows.ts` cut; then docs and skills; then tag `v2.0.0`.

## Open Questions

- Whether Homebrew's formula should install the Engine too (today it installs the CLI from the tag tarball and the CLI downloads the Engine on `kesha install`). Out of scope; the formula changes only its version source.
