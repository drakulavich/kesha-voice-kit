## 0. Reconcile

- [x] 0.1 Staleness check against #1259, #1263, #1270, #1271, #1284, #1285 and repository state (immutable releases, npm Trusted Publisher, two `SHA256SUMS`, label-gated alphas, Nix, Docker main pushes); proposal, design and delta specs corrected

## 1. Version

- [x] 1.1 Remove `package.json#keshaEngine.version`; set `rust/Cargo.toml` to `package.json#version`; `check:versions` asserts they are equal and that neither `keshaEngine` nor `kesha.engine` exists on `main` (cutover PR)
- [x] 1.2 `src/package-info.ts` resolves the Engine from `package.json#kesha.engine` injected at publish, falling back to the committed pin and then `version`; the installer verifies against the injected SHA-256s
- [ ] 1.4 `PINNED_ASSET_SHA256*` leave `src/engine-targets.ts`, and `sizeBytes` is injected or dropped from `--plan` (after the cutover: the pinned table still serves `check:engine-targets` and the size plan)
- [x] 1.3 CI lanes that download a published Engine resolve the newest stable Engine; `flake.nix` reads `cliPkg.version`

## 2. `release.yml`

- [x] 2.1 Rehearsal skeleton: `classify` (pure, tested) → `build` (three rows, one profile each) → `darwin-synthesis-smoke` + `roundtrip-smoke` on the artifacts → `github-release`, which assembles, checks against the manifest, signs and publishes in one `gh release create`; `requireReleaseRowsNameOneProfile`, the smoke rules and the tag-currency rule cover `release.yml`; `requireReleaseQueue` pins the publish queue
- [x] 2.2 `packages` before `github-release`, one merged `SHA256SUMS`; `npm` job (rehearsal packs and verifies the injected pin; publishing steps gated on `publish`); dist-tag per channel; `requireReleaseJobOrder` pins the order; pin derivation (pure, tested) and injection. The `cli-alpha` arm of `npm`'s `if:` arrives with 2.4
- [x] 2.3 `homebrew` and `docker` jobs with `needs: github-release`, stable only and skipped on a rehearsal; Docker's main-push image moves into `ci.yml` as `docker-image` (a PR builds without pushing when the recipe changes) and `docker.yml` keeps only tag images until the cutover; `requireReleaseJobOrder` covers both
- [x] 2.4 Alpha derivation moved in from `release-alpha.yml` as `plan` (every path; label gate kept) and `reserve-tag` (before `npm`); `npm` resolves a published Engine's `SHA256SUMS` when nothing was built; `requireReleaseJobOrder` holds `npm` behind `reserve-tag`. The dispatch inputs (`channel`, `version`, `engine-prerelease`) are wired with the trigger in 3.1

## 3. Cutover and deletions

- [x] 3.1 Cutover, one PR: `release.yml` triggers on (tags except alphas, `main` pushes, dispatch with `channel`/`version`/`engine-prerelease`). The permissions a rehearsal must not hold live in jobs that run only when `plan.publish` is true: `assemble` (no permission, so it runs in a rehearsal too) collects, checksums and checks the assets; `github-release` (`contents: write`, `id-token: write`) signs and publishes; `npm` packs and verifies (no permission); `npm-publish` (`id-token: write`) publishes; `npm-smoke` installs the published version; shared npm steps are the `prepare-npm-package` composite. Tasks 1.1 and 1.3; delete `build-engine.yml`, `release-cli.yml`, `npm-publish.yml`, `release-npm-publish.yml`, `homebrew-tap.yml`, `docker.yml`, `release-alpha.yml`, and `release-install-smoke.yml` (task 3.3), whose draft mode had no draft left to smoke. `requireNpmPublishAfterPackaging`, `forbidLinuxPackaging`, `requireBuildEngineSerialisesRunsPerRef` and `requireReusableCallPermissions` leave with the workflows they targeted; `requireReleaseJobOrder` covers the order, `forbidReusableWorkflows` the absence of `workflow_call`, and a write or OIDC grant requires `plan.publish`
- [x] 3.2 `post-engine-release.yml` becomes `release.yml`'s `post-release` job (a release created with `GITHUB_TOKEN` fires no `release: published`); it leads `package.json`, `server.json` and `rust/Cargo.toml`/`Cargo.lock` to the next minor, still refreshing the pinned SHA table until 1.4
- [x] 3.4 `prune-alpha-releases.yml` → `nightly.yml` (task 4.1)
- [x] 3.5 `cross-os-cache-probe.yml` → `ci.yml` (`cache-probe-save`/`-restore`/`-cleanup`, on a matching PR); `cache-seed.yml` and `cache-cleanup.yml` stay standalone (design D4: cancel-in-progress, and the `pull_request_target` write token)
- [x] 3.6 `linux-packages.yml` → `ci.yml`'s `linux-packages` job, with its PR and main-push path sets
- [x] 3.7 `rust-test.yml` → `ci.yml` (`lint-ubuntu`, `test`, `coverage`, `coreml-regression`, `rust-push-gate`), aggregated by `rust-tests`, still named `🧪 Rust Tests`; `requireEveryJobInCiAggregator` accepts either aggregator, and `rust-push-gate` now reds `🧪 Rust Tests` on `main` when it fails
- [x] 3.8 `nix-build.yml` stays standalone (design D4: #1105, it cannot gate the `🧪 CI` aggregator)
- [x] 3.9 `plugin-security-scan.yml` → `security.yml`'s `plugin-scan` job, same check name, still outside the `🛡️ Security Audit` aggregator; a push to `main` runs only the scan

## 4. `nightly.yml`, lint, docs

- [x] 4.1 `nightly.yml` with the six scheduled jobs (`capability-pact`, `cargo-dependency-maintenance`, `mini-model-pact`, `model-plan-size-canary`, `prune-alpha-releases`, `real-model-canary`), each on its own cron and concurrency group and dispatchable alone through `job`; `requirePactVerificationCoversEveryTarget` reads its `capability-pact` matrix
- [ ] 4.2 Pinned `actionlint` in `ci.yml`; cut `check-workflows.ts` to the rules D5 keeps
- [ ] 4.3 `docs/distribution.md` from the four distribution docs; one `release` skill; `.claude/rules/ci-and-build.md` names `release.yml`
- [ ] 4.4 Tag `v2.0.0` (maintainer), after switching the npm Trusted Publisher to `release.yml`
