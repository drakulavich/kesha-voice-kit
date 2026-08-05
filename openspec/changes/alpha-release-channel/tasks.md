## 1. Set the base version convention first

- [x] 1.1 After the next stable release, set `package.json#version` to the next unreleased version — `1.27.0` on `main` against `1.26.0` released (#691)
- [x] 1.2 Confirm the base stays strictly ahead of `package.json#keshaEngine.version`, so `check-versions.ts:104` (`cli >= engine`) still holds once a `-alpha.N` suffix is added — a prerelease sorts below its own stable version

## 2. Define the tag grammar and teach every validator

- [x] 2.1 Record the grammar: CLI alphas as `v<base>-alpha.N-cli`, Engine alphas as `v<engineVersion>-alpha.N` — one ERE string in `release-tags.mjs`, consumed by both bash and JS
- [x] 2.2 Confirm `build-engine.yml:3-13` (`v*` excluding `!v*-cli`) does not trigger on a CLI alpha tag
- [x] 2.3 Widen the Engine dispatch tag validator at `build-engine.yml:56` to accept `-alpha.N` alongside `-beta.N`
- [x] 2.4 Widen `RELEASE_TAG_RE` in `.github/scripts/release-manifest.mjs:8` to accept `-alpha.N`
- [x] 2.5 Confirm `npm-publish.yml:80-81` derives the expected version correctly from a CLI alpha tag once `-cli` is stripped
- [x] 2.6 Add tests asserting each validator accepts its own artifact's alpha shape and rejects the other artifact's

## 3. Extract the publish path (no behaviour change)

- [x] 3.1 Move the publish steps from `.github/workflows/npm-publish.yml:60-119` into a reusable `workflow_call` workflow taking version, tag and channel as inputs
- [x] 3.2 Make the reusable workflow apply the version input to `package.json` after its own checkout — a called workflow runs on its own runner and cannot see the caller's filesystem
- [x] 3.3 Make its version guard compare against the input rather than assuming the checkout already matches, and confirm `keshaEngine.version` is correct in the published tarball — `1.27.0-alpha.1` on npm carries `keshaEngine 1.24.7`
- [x] 3.4 Reduce `npm-publish.yml` to a thin caller, keeping its triggers and `id-token: write` intact
- [x] 3.5 Confirm every `${{ }}` expression reaching a `run:` block still passes through `env:`
- [ ] 3.6 Verify by dispatching against an already-published tag and confirming it no-ops on the prior-publish check

## 4. Teach the resolver about the alpha channel

- [x] 4.1 Extend the dist-tag resolver to three outcomes: `-alpha.` → `alpha`, other prereleases → `beta`, stable → `latest`
- [x] 4.2 Make the publish workflow exit successfully without publishing when the tag belongs to another artifact, rather than failing the version guard
- [x] 4.3 Add assertions covering all three resolver outcomes plus the foreign-tag case

## 5. Derive alpha versions

- [x] 5.1 Add a version-derivation script that reads existing tags and emits version, tag and channel, taking the CLI base from `package.json#version`
- [x] 5.2 Make the sequence one higher than the highest existing alpha for that base and artifact, ignoring tags that do not match the grammar
- [x] 5.3 Give the derivation an Engine mode that bases on `keshaEngine.version` rather than the CLI version — it takes the target explicitly, since an alpha *of* the pin would sort below it (#738)
- [x] 5.4 Make the derivation fail loudly if it would emit a version that cannot pass `check:versions`
- [x] 5.5 Fetch full history and tags before deriving, as `build-engine.yml:44-45` does
- [x] 5.6 Add unit tests: first alpha for a base, sequence advance, malformed tag ignored, foreign-artifact tag ignored, stable outranks its alphas
- [x] 5.7 Make the alpha workflow run those tests itself before consuming a derived version — passing in general CI does not gate a separate workflow

## 6. Publish CLI alphas continuously

- [x] 6.1 Add an alpha workflow on pushes to the default branch, always triggered, deciding inside a job whether the change can alter what a user runs
- [x] 6.2 Enumerate the paths that count, including `package.json`, `bun.lock`, `bin/`, shell completions and packaged files — not only `src/` — judged by `npm pack --dry-run` rather than by mirroring npm's rules (#704)
- [x] 6.3 Record a skip in a form a person can read afterwards — every run so far logs which gate refused and why
- [x] 6.4 Create and push the derived tag at the built commit **before** publishing, as the reservation that makes the version permanently taken
- [x] 6.5 Call the reusable publish workflow with the alpha channel — through `npm-publish.yml`, the only entry name npm's Trusted Publishing accepts (#731)
- [ ] 6.6 Generate release notes from the commits since the previous alpha tag for the same artifact — no notes exist to carry them while 6.10 stands
- [x] 6.7 Use `concurrency` with `queue: max` rather than a bare group — GitHub cancels an existing pending run when a newer one joins, dropping middle merges; queueing cannot be combined with `cancel-in-progress`
- [x] 6.8 Split privileges across jobs: unprivileged derivation and tests, a tag job with `contents: write` and no OIDC, a publish job with `id-token: write` and no tag write
- [x] 6.9 Pin every action in the new workflows by SHA
- [x] 6.10 Decide whether CLI alphas create a GitHub Release; if they do, make the publish workflow recognise its own tag on `release: published` and decline rather than republish — they do not: a CLI alpha leaves an npm version and a tag, nothing else
- [ ] 6.11 Verify three consecutive qualifying merges produce three distinct published alpha versions

## 7. Publish Engine alphas on demand

- [x] 7.1 Publish alpha tags as live Prereleases — created as a draft like every release, since immutable releases refuse an asset upload after publication, then un-drafted by a following step; beta keeps its draft, whose hand-validation gate is the point of that channel
- [ ] 7.2 Confirm an Engine alpha tag passes the widened validators from group 2 end to end, including manifest generation
- [ ] 7.3 Verify `kesha install --engine-version <alpha>` installs the Engine alpha, and that `kesha install` afterwards restores the pin — the pin itself may never name an alpha (#736 rule 3), so the old plan of matching `keshaEngine.version` to the alpha tag is not available (#738)
- [ ] 7.4 Confirm publishing an Engine alpha does not publish a CLI package and does not leave a red workflow run
- [x] 7.5 Let the release manifest accept an alpha tag above the pin, since the pin may never name one (#738), while still rejecting an alpha at or below it
- [x] 7.6 Apply the alpha tag's version to `rust/Cargo.toml` in the runner, so the binary does not report the pinned release it is meant to be tested against

## 8. Keep alpha artifacts out of stable lanes

- [x] 8.1 Make the lanes that download the published Engine (`ci.yml:387`, `:448`, `:501`) resolve an explicit stable version rather than inheriting possibly-prerelease metadata — solved upstream of the lanes instead: `check-versions.ts` rule 3 refuses an alpha pin outright, so no lane can inherit one
- [ ] 8.2 Verify an unrelated pull request is unaffected after an Engine alpha is published

## 9. Retention

- [ ] 9.1 Decide the retention window and which artifact it prunes, and record it in the spec, replacing the open issue
- [ ] 9.2 Add a scheduled job pruning alpha Releases past the window, leaving every stable release and every tag intact
- [x] 9.3 Confirm the derivation does not depend on a pruned Release still existing — `nextSequence` counts `git tag --list` and never reads Releases

## 10. Documentation

- [x] 10.1 Document the alpha channel in the release runbook and the `release-mechanics` skill, including the tag grammar and that `main` carries the next unreleased version
- [ ] 10.2 Add **channel**, **alpha** and **Prerelease** to `openspec/specs/GLOSSARY.md`
- [x] 10.3 Confirm no user-facing install hint points a first-time reader at the alpha channel, and that alpha install text says bun, never npm — the channel is named only in the maintainer-facing skill

## 11. End-to-end verification

- [ ] 11.1 Merge a CLI-only change and confirm an alpha publishes without human action — `1.27.0-alpha.1` published, but through `workflow_dispatch`; the label-on-merge path is still unexercised
- [x] 11.2 Install the alpha by naming the channel and confirm it runs
- [x] 11.3 Confirm an unqualified install still resolves the newest stable version before and after that alpha
- [ ] 11.4 Merge a docs-only change and confirm nothing publishes and the skip is visible
- [ ] 11.5 Dispatch an Engine alpha and install it end to end
- [x] 11.6 Confirm a CLI alpha tag left the Engine build workflow untriggered
