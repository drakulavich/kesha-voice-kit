## 1. Version

- [ ] 1.1 Remove `package.json#keshaEngine.version`; `check:versions` asserts `package.json#version == Cargo.toml version` and that no pin field exists
- [ ] 1.2 `src/install/execute.ts` resolves the Engine from `package.json#kesha.engine` injected at publish, falling back to `version`

## 2. `release.yml`

- [ ] 2.1 Skeleton: `classify` → `build-engine` (two profile rows) → `smoke` on artifacts → `github-release`
- [ ] 2.2 `npm` job via `workflow_call` with provenance; beta skipped
- [ ] 2.3 `packages`, `homebrew`, `docker`, `nix-version` jobs with `needs:`
- [ ] 2.4 Alpha derivation jobs moved in from `release-alpha.yml`

## 3. Deletions, one PR each

- [ ] 3.1 `build-engine.yml` 3.2 `release-cli.yml` 3.3 `release-npm-publish.yml` 3.4 `npm-publish.yml` 3.5 `post-engine-release.yml` 3.6 `release-install-smoke.yml` 3.7 `homebrew-tap.yml` 3.8 `linux-packages.yml` 3.9 `docker.yml` 3.10 `release-alpha.yml` 3.11 `prune-alpha-releases.yml` (into nightly) 3.12 `cache-seed.yml`/`cache-cleanup.yml`/`cross-os-cache-probe.yml` (into `ci.yml` or `nightly.yml`)

## 4. `nightly.yml`, lint, docs

- [ ] 4.1 `nightly.yml` with the six canary jobs
- [ ] 4.2 `actionlint` in `ci.yml`; cut `check-workflows.ts` to the four repository-specific rules
- [ ] 4.3 `docs/distribution.md` from the four distribution docs; one `release` skill; CLAUDE.md Releases section to one paragraph
- [ ] 4.4 Tag `v2.0.0`
