## 0. Reconcile

- [x] 0.1 Staleness check against #1259, #1263, #1270, #1271, #1284, #1285 and repository state (immutable releases, npm Trusted Publisher, two `SHA256SUMS`, label-gated alphas, Nix, Docker main pushes); proposal, design and delta specs corrected

## 1. Version

- [ ] 1.1 Remove `package.json#keshaEngine.version`; set `rust/Cargo.toml` to `package.json#version`; `check:versions` asserts they are equal and that neither `keshaEngine` nor `kesha.engine` exists on `main` (cutover PR)
- [ ] 1.2 `src/package-info.ts` resolves the Engine from `package.json#kesha.engine` injected at publish, falling back to `version`; the installer verifies against the injected SHA-256s; `PINNED_ASSET_SHA256*` and `sizeBytes` leave `src/engine-targets.ts`
- [ ] 1.3 CI lanes that download a published Engine resolve the newest stable Engine; `flake.nix` reads `cliPkg.version`

## 2. `release.yml`

- [x] 2.1 Rehearsal skeleton: `classify` (pure, tested) → `build` (three rows, one profile each) → `darwin-synthesis-smoke` + `roundtrip-smoke` on the artifacts → `github-release`, which assembles, checks against the manifest, signs and publishes in one `gh release create`; `requireReleaseRowsNameOneProfile`, the smoke rules and the tag-currency rule cover `release.yml`; `requireReleaseQueue` pins the publish queue
- [ ] 2.2 `packages` before `github-release`, one merged `SHA256SUMS`; `npm` job publishing with provenance through `setup-bun`; dist-tag per channel; `if: !cancelled() && (cli-alpha path || github-release succeeded)`; pin derivation (pure, tested) and injection
- [ ] 2.3 `homebrew` and `docker` jobs with `needs: github-release`, stable only; Docker's main-push image moves into `ci.yml`
- [ ] 2.4 Alpha derivation jobs moved in from `release-alpha.yml`, keeping the `alpha` label gate; dispatch inputs (`channel`, `version`, `engine-prerelease`); the `cli-alpha` path skips every Engine-building job and records its tag without triggering a run

## 3. Cutover and deletions

- [ ] 3.1 Cutover, one PR: `release.yml` triggers on, and `github-release` (`contents: write`, `id-token: write`) and `npm` (`id-token: write`) gain the permissions a rehearsal must not hold; tasks 1.1 and 1.3; delete `build-engine.yml`, `release-cli.yml`, `npm-publish.yml`, `release-npm-publish.yml`, `homebrew-tap.yml`, `docker.yml`, `release-alpha.yml`; `requireNpmPublishAfterPackaging` repointed at `release.yml`
- [ ] 3.2 `post-engine-release.yml` 3.3 `release-install-smoke.yml` 3.4 `prune-alpha-releases.yml` (into nightly) 3.5 `cache-seed.yml`/`cache-cleanup.yml`/`cross-os-cache-probe.yml` (into `ci.yml`) 3.6 `linux-packages.yml` (into `ci.yml`) 3.7 `rust-test.yml` (into `ci.yml`, job name `🧪 Rust Tests`) 3.8 `nix-build.yml` (into `ci.yml`) 3.9 `plugin-security-scan.yml` (into `security.yml`) — each with its orphaned scripts and tests

## 4. `nightly.yml`, lint, docs

- [ ] 4.1 `nightly.yml` with the six canary jobs
- [ ] 4.2 Pinned `actionlint` in `ci.yml`; cut `check-workflows.ts` to the rules D5 keeps
- [ ] 4.3 `docs/distribution.md` from the four distribution docs; one `release` skill; `.claude/rules/ci-and-build.md` names `release.yml`
- [ ] 4.4 Tag `v2.0.0` (maintainer)
