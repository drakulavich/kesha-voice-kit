## 1. Set the base version convention first

- [ ] 1.1 After the next stable release, set `package.json#version` to the next unreleased version
- [ ] 1.2 Confirm the base stays strictly ahead of `package.json#keshaEngine.version`, so `check-versions.ts:104` (`cli >= engine`) still holds once a `-alpha.N` suffix is added — a prerelease sorts below its own stable version

## 2. Define the tag grammar and teach every validator

- [ ] 2.1 Record the grammar: CLI alphas as `v<base>-alpha.N-cli`, Engine alphas as `v<engineVersion>-alpha.N`
- [ ] 2.2 Confirm `build-engine.yml:3-13` (`v*` excluding `!v*-cli`) does not trigger on a CLI alpha tag
- [ ] 2.3 Widen the Engine dispatch tag validator at `build-engine.yml:56` to accept `-alpha.N` alongside `-beta.N`
- [ ] 2.4 Widen `RELEASE_TAG_RE` in `.github/scripts/release-manifest.mjs:8` to accept `-alpha.N`
- [ ] 2.5 Confirm `npm-publish.yml:80-81` derives the expected version correctly from a CLI alpha tag once `-cli` is stripped
- [ ] 2.6 Add tests asserting each validator accepts its own artifact's alpha shape and rejects the other artifact's

## 3. Extract the publish path (no behaviour change)

- [ ] 3.1 Move the publish steps from `.github/workflows/npm-publish.yml:60-119` into a reusable `workflow_call` workflow taking version, tag and channel as inputs
- [ ] 3.2 Make the reusable workflow apply the version input to `package.json` after its own checkout — a called workflow runs on its own runner and cannot see the caller's filesystem
- [ ] 3.3 Make its version guard compare against the input rather than assuming the checkout already matches, and confirm `keshaEngine.version` is correct in the published tarball
- [ ] 3.4 Reduce `npm-publish.yml` to a thin caller, keeping its triggers and `id-token: write` intact
- [ ] 3.5 Confirm every `${{ }}` expression reaching a `run:` block still passes through `env:`
- [ ] 3.6 Verify by dispatching against an already-published tag and confirming it no-ops on the prior-publish check

## 4. Teach the resolver about the alpha channel

- [ ] 4.1 Extend the dist-tag resolver to three outcomes: `-alpha.` → `alpha`, other prereleases → `beta`, stable → `latest`
- [ ] 4.2 Make the publish workflow exit successfully without publishing when the tag belongs to another artifact, rather than failing the version guard
- [ ] 4.3 Add assertions covering all three resolver outcomes plus the foreign-tag case

## 5. Derive alpha versions

- [ ] 5.1 Add a version-derivation script that reads existing tags and emits version, tag and channel, taking the CLI base from `package.json#version`
- [ ] 5.2 Make the sequence one higher than the highest existing alpha for that base and artifact, ignoring tags that do not match the grammar
- [ ] 5.3 Give the derivation an Engine mode that bases on `keshaEngine.version` rather than the CLI version
- [ ] 5.4 Make the derivation fail loudly if it would emit a version that cannot pass `check:versions`
- [ ] 5.5 Fetch full history and tags before deriving, as `build-engine.yml:44-45` does
- [ ] 5.6 Add unit tests: first alpha for a base, sequence advance, malformed tag ignored, foreign-artifact tag ignored, stable outranks its alphas
- [ ] 5.7 Make the alpha workflow run those tests itself before consuming a derived version — passing in general CI does not gate a separate workflow

## 6. Publish CLI alphas continuously

- [ ] 6.1 Add an alpha workflow on pushes to the default branch, always triggered, deciding inside a job whether the change can alter what a user runs
- [ ] 6.2 Enumerate the paths that count, including `package.json`, `bun.lock`, `bin/`, shell completions and packaged files — not only `src/`
- [ ] 6.3 Record a skip in a form a person can read afterwards
- [ ] 6.4 Create and push the derived tag at the built commit **before** publishing, as the reservation that makes the version permanently taken
- [ ] 6.5 Call the reusable publish workflow with the alpha channel
- [ ] 6.6 Generate release notes from the commits since the previous alpha tag for the same artifact
- [ ] 6.7 Use `concurrency` with `queue: max` rather than a bare group — GitHub cancels an existing pending run when a newer one joins, dropping middle merges; queueing cannot be combined with `cancel-in-progress`
- [ ] 6.8 Split privileges across jobs: unprivileged derivation and tests, a tag job with `contents: write` and no OIDC, a publish job with `id-token: write` and no tag write
- [ ] 6.9 Pin every action in the new workflows by SHA
- [ ] 6.10 Decide whether CLI alphas create a GitHub Release; if they do, make the publish workflow recognise its own tag on `release: published` and decline rather than republish
- [ ] 6.11 Verify three consecutive qualifying merges produce three distinct published alpha versions

## 7. Publish Engine alphas on demand

- [ ] 7.1 Change `.github/workflows/build-engine.yml:484` to draft only stable tags, publishing alpha tags as non-draft Prereleases
- [ ] 7.2 Confirm an Engine alpha tag passes the widened validators from group 2 end to end, including manifest generation
- [ ] 7.3 Verify `kesha install` resolves an Engine alpha through `src/engine-install.ts:200` when `keshaEngine.version` matches the alpha tag
- [ ] 7.4 Confirm publishing an Engine alpha does not publish a CLI package and does not leave a red workflow run

## 8. Keep alpha artifacts out of stable lanes

- [ ] 8.1 Make the lanes that download the published Engine (`ci.yml:387`, `:448`, `:501`) resolve an explicit stable version rather than inheriting possibly-prerelease metadata
- [ ] 8.2 Verify an unrelated pull request is unaffected after an Engine alpha is published

## 9. Retention

- [ ] 9.1 Decide the retention window and which artifact it prunes, and record it in the spec, replacing the open issue
- [ ] 9.2 Add a scheduled job pruning alpha Releases past the window, leaving every stable release and every tag intact
- [ ] 9.3 Confirm the derivation does not depend on a pruned Release still existing

## 10. Documentation

- [ ] 10.1 Document the alpha channel in the release runbook and the `release-mechanics` skill, including the tag grammar and that `main` carries the next unreleased version
- [ ] 10.2 Add **channel**, **alpha** and **Prerelease** to `openspec/specs/GLOSSARY.md`
- [ ] 10.3 Confirm no user-facing install hint points a first-time reader at the alpha channel, and that alpha install text says bun, never npm

## 11. End-to-end verification

- [ ] 11.1 Merge a CLI-only change and confirm an alpha publishes without human action
- [ ] 11.2 Install the alpha by naming the channel and confirm it runs
- [ ] 11.3 Confirm an unqualified install still resolves the newest stable version before and after that alpha
- [ ] 11.4 Merge a docs-only change and confirm nothing publishes and the skip is visible
- [ ] 11.5 Dispatch an Engine alpha and install it end to end
- [ ] 11.6 Confirm a CLI alpha tag left the Engine build workflow untriggered
