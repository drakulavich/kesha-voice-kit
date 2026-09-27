## Context

Tags today: `release-tags.mjs:11-39` (`vX.Y.Z`, `-beta.N`, `-alpha.N`, `-cli` marker). Draft/un-draft: `classify-release-tag.mjs:5-10`. Pin refusal for alphas: `check-versions.ts:82-91`. Event-triggered downstream: `npm-publish.yml:18-20`, `homebrew-tap.yml:3-5`, `post-engine-release.yml:3-5`; explicit dispatch workaround: `dispatch-npm-publish.sh:15`. Linux packages keyed on the `-cli` marker: `release-cli.yml`. Docker excludes alphas: `docker.yml:6`. Nix writes an Engine version marker from `package.json#keshaEngine.version`: `flake.nix:173`.

Facts checked on 2026-09-27 that this design depends on:

- **Immutable releases are on** (`gh api repos/drakulavich/kesha-voice-kit/immutable-releases` → `{"enabled":true}`); an asset uploaded after publication fails with 422 (`build-engine.yml:417`). `gh release create <tag> <files>` drafts, uploads and publishes in one call, so every asset of a release must exist before that call.
- **npm Trusted Publishing** matches the calling workflow's file name and allows one publisher per package (#732, quoting npm's docs); the registered one is `npm-publish.yml`.
- **Two files named `SHA256SUMS`** exist per version pair today: one on the Engine release (`v1.26.0`), one on the CLI release (`v1.31.0-cli`, covering the `.deb`/`.rpm`). One tag can carry only one.
- **The Engine SHA-256 pin** (#1263): `src/engine-targets.ts` commits `PINNED_ASSET_SHA256` for `PINNED_ASSET_SHA256_VERSION`, rewritten with `sizeBytes` by the post-release PR (`post-engine-release.ts`). A version the table does not describe falls back to the release's own `SHA256SUMS`.
- **The per-merge alpha is label-gated** (`alpha-requested.sh`): a push publishes only when its pull request carries the `alpha` label and changed packed files.
- **Nix publishes nothing**: `flake.nix` derives its version marker from `package.json` when it builds; no workflow writes a Nix file.
- **Docker also pushes from `main`** (`docker.yml:4`, path-filtered), not only from tags.
- `check-workflows.ts` holds ~33 rules, not eight: #1271 added `forbidLongInlineRun` and `forbidExpressionsInRun`, which actionlint does not enforce; #1285 added `requireReleaseRowsNameOneProfile`; #1259 added the Rust toolchain pin check inside the `setup-rust` composite.
- actionlint 1.7.12 (latest) rejects `concurrency.queue` as an unknown key, and `queue: max` is load-bearing (`npm-publish.yml:37-39`).

## Goals / Non-Goals

Goals: one number to bump; one workflow to read; no event cascade to reason about; alphas keep rehearsing the path. Non-goals: as in the proposal.

## Decisions

### D1. Version and pin

`package.json#version` is the only version. The CLI resolves its Engine as: stable `X.Y.Z` → Engine `vX.Y.Z`; beta `X.Y.Z-beta.N` → Engine `vX.Y.Z-beta.N`; alpha `X.Y.Z-alpha.N` published from a `main` push → the newest stable Engine tag at publish time; alpha dispatched by a person → the Engine built in that same run, or the Engine Prerelease named by `engine-prerelease`, which skips the build.

The resolution is written into the published package as `package.json#kesha.engine = { version, sha256: { <asset>: <hex> }, size: { <asset>: <bytes> } }`, injected at publish the way alpha versions are injected today, and never committed to `main`. The hashes and sizes come from the merged `SHA256SUMS` and the asset files of the release it resolves — the same run's smoked assets for stable, beta and a building alpha, the resolved release's `SHA256SUMS` otherwise. That replaces the committed `PINNED_ASSET_SHA256`, `PINNED_ASSET_SHA256_VERSION` and `sizeBytes` in `src/engine-targets.ts` and the post-release PR that rewrote them; without it, every release after the post-release job is deleted would silently fall back to trusting the release's own `SHA256SUMS`. A source checkout carries no injection: it resolves `version`, verifies against that release's `SHA256SUMS` (the #1263 fallback), and `--plan` reports the Engine size as unknown. `check:versions` rule 3 becomes: `main` carries neither `keshaEngine` nor `kesha.engine`.

Interim: the cutover sets `rust/Cargo.toml` to `package.json#version` (1.32.0), not the other way round, so `package.json#version` moves only in the `release/2.0.0` PR. Between that and the `v2.0.0` tag a source checkout names an Engine that does not exist, so every CI lane that downloads a published Engine resolves the newest stable Engine instead of `version` — the rule the installation spec already states for alpha assets.

Why not build an Engine per per-merge CLI alpha: `release-channels` requires Engine alphas to be deliberate, and a per-merge build costs ~9 min × 3 runners for a rehearsal that changes no Engine bytes.

### D2. `release.yml`

Triggered by `push` to tags matching `v*` but not `v*-alpha.*`, `push` to `main` (the per-merge CLI alpha path), `workflow_dispatch` (a beta with a version; or an alpha, which builds the Engine in the same run, or names an existing Engine Prerelease through `engine-prerelease` and skips the build), and `pull_request` on the release machinery's paths, which **rehearses** the stable path: it builds and smokes every asset and assembles the release directory, and stops before signing (a public transparency-log write) and publishing. Alpha tags are records written after publishing and never triggers.

Concurrency: `group: release-${{ github.event_name == 'pull_request' && github.ref || 'publish' }}`, `queue: max`, no `cancel-in-progress`. Every publishing run shares one queue, so three quick merges each publish their own alpha in order; a rehearsal queues per pull request, so it never holds a real release behind it. `requireReleaseQueue` in `check-workflows.ts` pins all three.

`classify` (`.github/scripts/release-classify.ts`, a pure function under test) decides the path from the event and refuses any tag not matching `^v\d+\.\d+\.\d+(-(alpha|beta)\.\d+)?$`, any alpha tag, the legacy `-cli` marker, and any tag whose version differs from `package.json#version`. It outputs `path` (`stable`, `beta`, `alpha`, `cli-alpha`, `rehearsal`), `channel`, `version`, `tag`, `prerelease`, `dist_tag`, `build_engine` and `publish`.

Jobs, in dependency order:

1. `classify`.
2. `build` — the three release rows, each naming one Cargo profile (`darwin`, `portable`); each row smoke-tests `describe` and, off macos-14, synthesises before upload.
3. Smokes on the artifacts: `darwin-synthesis-smoke` (Kokoro and the AVSpeech sidecar on macos-15) and `roundtrip-smoke` (linux-x64: version, `describe`, ASR warm-up, a transcript of a fixture, synthesis transcribed back — the manual draft smoke of `release-install-smoke.yml`, moved ahead of publication).
4. `packages` — `.deb`/`.rpm` through `./.github/actions/linux-packages`, uploaded as an artifact; stable only.
5. `assemble` — needs every smoke and `packages`; downloads all artifacts into one directory, adds the SBOM and manifest, writes **one** `SHA256SUMS` over everything and checks the directory against the manifest (`check-release-assets.ts`). It holds no permission, so a rehearsal runs it in full.
6. `github-release` — runs only when `plan.publish`; signs every asset, verifies the tag still names this run's commit, and publishes with one `gh release create` — Latest for stable, Prerelease otherwise. Nothing is left as a draft.
7. `post-release` (`contents: write`, `pull-requests: write`, stable only) opens the pull request that leads `main` to the next minor, as `post-engine-release.yml` did.
8. `npm` packs the version with the injected pin and verifies it (no permission); `npm-publish` (`id-token: write`) needs `npm`, `github-release` when an Engine was built, and `reserve-tag` for an alpha that built none; `npm-smoke` installs the published version from the registry. `homebrew` and `docker` need `github-release`, stable only.

`build`, the smokes and `assemble` carry `if: build_engine`; every job holding a write or OIDC grant carries `plan.publish`; `packages`, `homebrew` and `docker` carry `channel == 'stable'`. No job subscribes to a `release:` event and no `workflow_call` is used: shared steps are composite actions under `.github/actions/`.

### D3. Alpha and beta

Alpha keeps `release-alpha.yml`'s gates (`alpha-publishable.ts` and the `alpha` label of `alpha-requested.sh`) in a `plan` job every run passes through (`release-plan.ts`, a pure function under test). The derived version is `X.Y.Z-alpha.N` with `X.Y.Z = package.json#version`, which must lead the highest published stable of either tag shape — today's re-lead step after a release stays the remedy; the sequence counts both `vX.Y.Z-alpha.N` and legacy `vX.Y.Z-alpha.N-cli`, because npm already holds those versions. A non-building alpha reserves its tag in `reserve-tag` (`contents: write`, no OIDC) before `npm` publishes, as `release-alpha.yml` does today; a building one gets its tag from `github-release`. The Engine resolution follows D1, and the Engine-building jobs are skipped. A dispatched alpha builds the Engine, publishes it as a Prerelease and publishes the CLI at the same version. The derivation runs inside the publish queue, so the tag it counts is always the previous run's.

Beta is dispatched with a version extending `package.json#version`, or pushed as a tag the commit carries; it builds the Engine, publishes a Prerelease in the same run, reaches npm on the `beta` dist-tag, and is never pruned.

### D4. `nightly.yml` and the folds

`nightly.yml` jobs: `capability-pact`, `cargo-dependency-maintenance`, `mini-model-pact`, `model-plan-size-canary`, `prune-alpha-releases`, `real-model-canary`, each with the schedule and permissions it has today, each independently dispatchable through a `job` input. `ci.yml` absorbs `rust-test.yml` (its aggregate job keeps the exact name `🧪 Rust Tests`), `nix-build.yml`, `linux-packages.yml` (the PR lane), `cache-seed.yml`, `cache-cleanup.yml`, `cross-os-cache-probe.yml` and Docker's main-push image; `security.yml` absorbs `plugin-security-scan.yml`. Required checks match on name only (`🧪 CI`, `🧪 Rust Tests`; `🛡️ Security Audit` on the GitHub Actions app), so no branch-protection setting changes.

### D5. Lint

`actionlint` (version pinned, SHA-256-verified download) runs in `ci.yml` and owns syntax, expression typing and shellcheck of `run:` blocks, with one ignore for the `concurrency.queue` key it does not know yet. `check-workflows.ts` keeps what actionlint does not enforce — pins, timeouts, Windows bash, pipefail, the 3-line `run:` cap and `${{ }}`-in-`run:` ban (#1271), the Rust toolchain pin in composites (#1259), the code-filter rules — plus the repository invariants: `requireReleaseRowsNameOneProfile`, `requirePreUploadSynthesisSmoke`, `requireDarwinSmokeCoversBothEngines`, `requireReleaseVerifiesTagIsCurrent` and `requireReleaseQueue` on `release.yml`, `requirePactVerificationCoversEveryTarget`, `requireRestoreOnlyCachesHaveAWriter`, and `requireReleaseJobOrder`, which holds `npm-publish` behind `github-release` and `reserve-tag` and every write or OIDC grant behind `plan.publish`. Rules whose only target is a retired workflow leave with it.

## Risks / Trade-offs

- A CLI-only fix now rebuilds the Engine (~9 min, ~190 MB re-uploaded). Accepted.
- An Engine hotfix is also a CLI release. Accepted; one CHANGELOG stream.
- Publishing without a draft removes the last manual gate before a release is visible. Accepted because the smokes, including the round trip the manual draft smoke ran, now run on the just-built assets first.
- The npm Trusted Publisher switch is a manual step outside the repository; until it happens `release.yml` cannot publish to npm, which is why its `npm` job stays rehearsal-only until the cutover.
- A rehearsal costs one Engine build per pull request that touches the release machinery. Accepted: build-engine.yml had no pre-merge coverage at all.

## Migration Plan

Stage 4, after `core-api-v2` and `build-profiles` (both archived). Every PR leaves `main` releasable through the old workflows until the cutover PR retires them:

1. Spec reconciliation and the `release.yml` rehearsal skeleton: `classify`, `build`, smokes, `github-release`.
2. `packages` before `github-release` with one merged `SHA256SUMS`; the `npm` job (rehearsal packs and verifies, never publishes); the pin derivation and injection. The maintainer switches the npm Trusted Publisher when the cutover merges.
3. `homebrew` and `docker` jobs; Docker's main-push lane moves into `ci.yml`.
4. Alpha derivation and dispatch inputs, inert until the cutover.
5. Cutover, atomic: tag, main-push and dispatch triggers on; version unification; `flake.nix`; CI lanes resolve the newest stable Engine; `build-engine.yml`, `release-cli.yml`, `npm-publish.yml`, `release-npm-publish.yml`, `homebrew-tap.yml`, `docker.yml`, `release-alpha.yml`, `release-install-smoke.yml` and `post-engine-release.yml` (now the `post-release` job) deleted in the same PR, because any one left behind would build or publish the same tag twice (the last had no draft left to smoke).
6. Deletions of the now-idle workflows, one per PR, with their scripts and tests: `prune-alpha-releases.yml` (into nightly), the cache workflows, `linux-packages.yml`, `rust-test.yml`, `nix-build.yml`, `plugin-security-scan.yml`.
7. `nightly.yml`.
8. `actionlint` and the `check-workflows.ts` cut.
9. Docs, one `release` skill, archive this change.
10. The maintainer tags `v2.0.0`.

## Open Questions

- Whether Homebrew's formula should install the Engine too. Out of scope; the formula changes only its version source.
