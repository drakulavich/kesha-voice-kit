## 1. Extract the publish path (no behaviour change)

- [ ] 1.1 Move the publish steps from `.github/workflows/npm-publish.yml:60-119` (version guard, prior-publish check, dist-tag resolution, publish with provenance) into a reusable `workflow_call` workflow taking version, tag and channel as inputs
- [ ] 1.2 Reduce `npm-publish.yml` to a thin caller of the reusable workflow, keeping its `release: published` and `workflow_dispatch` triggers and its `id-token: write` permission intact
- [ ] 1.3 Confirm every `${{ }}` expression reaching a `run:` block still passes through `env:` rather than direct interpolation
- [ ] 1.4 Verify the extraction by dispatching the workflow against an already-published tag and confirming it no-ops on the prior-publish check instead of republishing

## 2. Teach the resolver about the alpha channel

- [ ] 2.1 Extend the dist-tag resolver to three outcomes: `-alpha.` → `alpha`, other prereleases → `beta`, stable → `latest`
- [ ] 2.2 Make the publish workflow exit successfully without publishing when the tag is an Engine-only release rather than failing the version guard
- [ ] 2.3 Add a test or dry-run assertion covering all three resolver outcomes plus the Engine-only tag case

## 3. Derive alpha versions

- [ ] 3.1 Add a version-derivation script that reads existing tags and emits version, tag and channel, taking the base from `package.json#version`
- [ ] 3.2 Make the sequence one higher than the highest existing alpha for that base, ignoring tags that do not match the alpha naming scheme
- [ ] 3.3 Add unit tests for the derivation: first alpha for a base, sequence advance, malformed tag ignored, stable outranks its alphas
- [ ] 3.4 Wire the tests to run in CI before any workflow consumes the derived version
- [ ] 3.5 Confirm `bun run check:versions` passes for a derived alpha version

## 4. Publish CLI alphas continuously

- [ ] 4.1 Add an alpha workflow triggered on pushes to the default branch, with a path filter that skips changes which cannot alter what a user runs
- [ ] 4.2 Write the derived version into `package.json` in the runner without committing it
- [ ] 4.3 Call the reusable publish workflow with the alpha channel
- [ ] 4.4 Create and push the derived alpha tag at the built commit, so the next derivation counts it and the next release notes have a boundary
- [ ] 4.5 Fail the run if the artifact published but its tag did not land, rather than reporting success
- [ ] 4.6 Generate release notes from the commits since the previous alpha tag
- [ ] 4.7 Add a concurrency group so overlapping merges each end with a distinct published version
- [ ] 4.8 Make a skipped run report the skip explicitly rather than failing
- [ ] 4.9 Verify two consecutive qualifying merges produce two distinct published alpha versions

## 5. Publish Engine alphas on demand

- [ ] 5.1 Change `.github/workflows/build-engine.yml:484` to draft only stable tags, publishing alpha tags as non-draft Prereleases
- [ ] 5.2 Confirm an Engine alpha tag flows through the existing prerelease detection at `:409-411` unchanged
- [ ] 5.3 Verify `kesha install` resolves an Engine alpha through `src/engine-install.ts:200` with no code change when `keshaEngine.version` matches the alpha tag
- [ ] 5.4 Confirm publishing an Engine alpha does not publish a CLI package and does not leave a red workflow run

## 6. Keep alpha artifacts out of stable lanes

- [ ] 6.1 Pin the lanes that download the published Engine (`ci.yml:387`, `:448`, `:501`) to the stable channel
- [ ] 6.2 Verify an unrelated pull request is unaffected after an Engine alpha is published

## 7. Retention

- [ ] 7.1 Decide the retention window and record it in the spec, replacing the open issue
- [ ] 7.2 Add a scheduled job pruning alpha Releases past the window, leaving every stable release intact
- [ ] 7.3 Confirm the version derivation does not depend on a pruned Release still existing

## 8. Versioning convention and documentation

- [ ] 8.1 After the next stable release, set `package.json#version` to the next unreleased version
- [ ] 8.2 Document the alpha channel in the release runbook and the `release-mechanics` skill, including that `main` carries the next unreleased version
- [ ] 8.3 Add **channel**, **alpha** and **Prerelease** to `openspec/specs/GLOSSARY.md`
- [ ] 8.4 Confirm no user-facing install hint or documentation entry point points a first-time reader at the alpha channel, and that alpha install text says bun, never npm

## 9. End-to-end verification

- [ ] 9.1 Merge a CLI-only change and confirm an alpha publishes without human action
- [ ] 9.2 Install the alpha by naming the channel and confirm it runs
- [ ] 9.3 Confirm an unqualified install still resolves the newest stable version before and after that alpha
- [ ] 9.4 Merge a docs-only change and confirm nothing publishes
- [ ] 9.5 Dispatch an Engine alpha and install it end to end
