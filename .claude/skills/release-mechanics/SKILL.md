---
name: release-mechanics
description: Use when touching anything release-shaped — version bumps, tags, draft releases, npm publish and provenance, the build-engine feature matrix, release/* PRs, bun link, or CI jobs that download a published engine. Explains why CLI and engine version independently, why tag names are one-use, why draft assets 404 for anonymous clients, and how Greptile re-review and auto-merge behave. To actually cut a release use the release-engine skill (engine) or release-cli skill (npm) instead; this one is the reference behind both.
---

# Release mechanics

## RELEASE PROCESS — CLI AND ENGINE ARE VERSIONED INDEPENDENTLY

`package.json#version` (CLI) and `package.json#keshaEngine.version` (engine, mirrored in `rust/Cargo.toml`) are decoupled. `src/engine-install.ts` downloads `v${keshaEngine.version}` with fallback to `package.json#version`.

Version drift gate: `bun .github/scripts/check-versions.ts` (`bun run check:versions` / `make versions`, CI "🔢 Check version drift") enforces:

1. `keshaEngine.version === rust/Cargo.toml#version` — one engine version stored twice; drift makes `kesha install` fetch the wrong source/release.
2. `package.json#version >= keshaEngine.version` — CLI may lead for CLI-only patches, never lag.

**CLI-only patch** (docs, TS, plugin): bump `package.json#version` and the two `server.json` versions with it (rule 4 rejects the commit otherwise); leave `keshaEngine.version` + `rust/Cargo.toml`; PR CI uses the existing engine; merge; create a marker release:

CLI-only is allowed only when the changed CLI surface works against the already-published engine pinned by `package.json#keshaEngine.version`. If a CLI command delegates to a new engine subcommand, capability flag, feature behavior, or output contract, it is an **engine release**: bump `package.json#keshaEngine.version`, `rust/Cargo.toml`, and `rust/Cargo.lock` together. Before cutting any `v*-cli` marker, smoke-test new/changed CLI commands against the published pinned engine, not only a repo-local engine build. The `v1.18.2-cli` / `v1.18.3-cli` mistake was exposing `kesha record` while the pinned published engine was still `v1.18.0` and did not implement `kesha-engine record`.

```bash
git tag -a vX.Y.Z-cli --cleanup=verbatim -F notes.md && git push origin vX.Y.Z-cli
npm view @drakulavich/kesha-voice-kit version   # a few minutes, expect X.Y.Z
```

`v*-cli` is excluded from `build-engine.yml` and picked up by `🚀 Release (CLI)` (`release-cli.yml`), which builds the Linux `.deb`/`.rpm`, creates the marker release as a **draft** with them plus `SHA256SUMS`, un-drafts it, then dispatches `📦 npm Publish` and waits for it. Its body is the tag annotation followed by one generated line whose engine half is computed against the previous stable `-cli` tag's pin — the marker is how a new engine reaches users, and the line used to assert "(unchanged)" on exactly those releases (#788). A lightweight tag is still accepted; it just contributes no notes. Un-drafting from a workflow fires no `release: published` (a `GITHUB_TOKEN` event does not cascade), so the dispatch is explicit — which is also why the tag must be pushed by a **human**: a token-pushed tag triggers nothing. That is by design for the alpha lane, whose `-cli` tags have no GitHub release.

The lane refuses to proceed if `package.json#version` at the tag is not exactly the version the tag names — the packages carry that field, and nothing downstream re-checks it since #727 (#728). **Cut one stable CLI release at a time.** `npm-publish.yml`'s `concurrency: queue: max` serialises runs but does not order them by version, so two stable markers in flight together can still finish out of order and leave `latest` on the older one.

**Recovering a failed lane run.** Which recovery applies depends on how far it got; the failing run prints the right one, and `gh release view vX.Y.Z-cli` tells you directly.

| state | what happened | recovery |
| --- | --- | --- |
| no release | died in `plan` or during the build | fix the cause, re-run the lane |
| **draft** | died between `create --draft` and `--draft=false` | assets all present → `gh release edit vX.Y.Z-cli --draft=false` then dispatch npm. Otherwise `gh release delete vX.Y.Z-cli --yes` (safe while draft — only publishing reserves the tag name) and re-run the lane |
| published | the release is out, npm publish failed | re-run the publish alone |

A leftover draft is not inert: `assert-release-absent.sh` counts drafts, so it blocks a re-run until it is finished or deleted. Re-running just the publish is idempotent — an already-published version exits 0 without republishing:

```bash
gh workflow run npm-publish.yml --ref vX.Y.Z-cli -f tag=vX.Y.Z-cli
```

Two things do *not* go through this lane. A **beta marker** (`vX.Y.Z-beta.N-cli`) is skipped with a notice — betas ship no Linux packages and keep the human un-draft gate, so cut them the legacy way with `gh release create vX.Y.Z-beta.N-cli --notes …`, which still fires `📦 npm Publish` on publication. **Alpha markers** are minted and published by `release-alpha.yml` and never get a GitHub release at all. The legacy `gh release create vX.Y.Z-cli` still works for a stable marker too, but ships no packages and leaves the tag unusable by this lane — do not use it.

**Engine release** (anything under `rust/` or an engine bump):

1. Bump `rust/Cargo.toml`, `rust/Cargo.lock` (`cargo check`), `package.json#keshaEngine.version` — leave `package.json#version` alone, it carries the next unreleased CLI (#691). An engine tag publishes nothing to npm; the bumped pin reaches users with the next `-cli` release (#729). If the engine would overtake the CLI line, raise it to match — rule 2 (`cli >= engine`) rejects the commit otherwise — but never lower it.
2. Merge to main.
3. Tag/push **annotated, with the notes as the message**: `git tag -a vX.Y.Z --cleanup=verbatim -F notes.md && git push origin refs/tags/vX.Y.Z` → `build-engine.yml`, whose release job reads `git tag -l --format='%(contents)'` into the draft body. A lightweight tag leaves the body empty.
4. If the tag was lightweight, write the notes before publishing:

   ```bash
   gh release edit vX.Y.Z --notes "$(cat <<'EOF'
   <summary of changes, new features, breaking changes, PR list>
   EOF
   )"
   ```

   Template: v1.1.3 style — features → platform support → breaking changes → shipped PRs → follow-up issues → upgrade instructions. If notes were forgotten on a published release, `gh release edit --notes` can silently drop them; patch via API:

   ```bash
   RELEASE_ID=$(gh api repos/OWNER/REPO/releases/tags/vX.Y.Z --jq '.id')
   jq -Rs '{body: .}' < notes.md > body.json
   gh api -X PATCH "repos/OWNER/REPO/releases/$RELEASE_ID" --input body.json
   ```

5. Validate draft assets before un-drafting. Authenticated `gh release download` works on drafts; anonymous `curl` / `kesha install` 404s. Release drafts must include `SHA256SUMS`, `kesha-release-manifest.json`, one `*.sigstore.json` per non-signature asset, and `kesha-voice-kit-vX.Y.Z.spdx.json`.

   ```bash
   gh release download vX.Y.Z -p SHA256SUMS -p kesha-release-manifest.json -p '*.sigstore.json' -p 'kesha-*' -p 'say-*' -D <smoke-dir>
   cd <smoke-dir>
   sha256sum -c SHA256SUMS
   cosign verify-blob \
     --bundle kesha-engine-darwin-arm64.sigstore.json \
     --certificate-identity "https://github.com/drakulavich/kesha-voice-kit/.github/workflows/build-engine.yml@refs/tags/vX.Y.Z" \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     kesha-engine-darwin-arm64
   ```

6. Treat `make smoke-test` as a local sanity check only; it can run the old globally installed CLI/engine. The release gate is draft-asset validation.
7. Publish: `gh release edit vX.Y.Z --draft=false`. A bare engine tag reaches **no npm package** — `npm-publish.yml` skips its publish job on `engine_only` (#729) — but it does fire `🍺 Homebrew Tap`. The CLI arrives with its own `-cli` marker; see the `release-cli` skill.
8. Stable `vX.Y.Z` engine releases also update `drakulavich/homebrew-tap` via `🍺 Homebrew Tap` using `HOMEBREW_TAP_TOKEN` scoped only to the tap repo. CLI-only marker releases skip Homebrew. **Engine releases no longer attach Linux `.deb`/`.rpm`**: those packages carry `package.json#version`, which `main` holds ahead of npm since #691, so naming them on an engine tag meant naming a CLI version npm had not published. The gate that checked this (`assert-npm-published.mjs`) made stable engine tags unreleasable and is gone. They ship from the stable `-cli` marker instead (#728) — the package *is* the CLI — which is the one release that publishes the same version to npm in the same run; `linux-packages.yml` keeps building and smoke-installing the pair on `main` as CI. `check-workflows.ts` holds both halves: `forbidLinuxPackaging` keeps them off engine tags, `requireNpmPublishAfterPackaging` keeps the `-cli` lane's npm publish downstream of the packaging job.

**Prerelease channels.** The validators accept two shapes beside stable — `vX.Y.Z-beta.N` and `vX.Y.Z-alpha.N` (a CLI release on either channel adds the `-cli` marker) — and the grammar has one home, `release-tags.mjs`. Neither channel can reach `latest`: `npm-dist-tag.mjs` derives the dist-tag from the SemVer prerelease identifier, returns `latest` only for a version that has none, and *refuses* one whose identifier decodes to `latest` (`1.27.0-latest.1`) rather than handing a prerelease to everyone who never asked for a channel.

| | alpha | beta |
| --- | --- | --- |
| for | rehearsing the publish path — a merged PR labelled `alpha` that changed something npm packs | a candidate you want people to install and test |
| version | derived from tags at publish time, never committed | committed in all three version fields |
| dist-tag | `alpha` | `beta` |
| reaches | CLI: whoever asked, `bun add -g @drakulavich/kesha-voice-kit@alpha`. Engine: `kesha install --engine-version X.Y.Z-alpha.N` | the same two, with `@beta` / `-beta.N` |
| skips | Homebrew, **and the human un-draft gate** | Homebrew |
| promotion | none — it is evidence, not a candidate; cut a beta or a stable | a later stable `vX.Y.Z` |
| Releases | engine alphas pruned after 30 days; tags kept | kept |

The dist-tag rows are about **CLI** tags. Only a `-cli` tag publishes to npm; a bare `vX.Y.Z[-beta.N|-alpha.N]` names the engine and reaches users through the GitHub Release, never through a channel (#729).

**Beta engine release** (deliberate, human-gated):

- Use SemVer prerelease versions in all three places: `package.json#version`, `package.json#keshaEngine.version`, and `rust/Cargo.toml`, for example `1.18.7-beta.1`; tag as `v1.18.7-beta.1`.
- `build-engine.yml` creates a **draft prerelease** and uploads engine binaries, sidecars, `SHA256SUMS`, manifest, SBOM, and Sigstore bundles.
- Verify before promoting exactly as for stable — engine-release step 5, authenticated `gh release download` against the draft — then `gh release edit vX.Y.Z-beta.N --draft=false`. Testers install the binary with `kesha install --engine-version X.Y.Z-beta.N`.
- Un-drafting a beta engine tag publishes **nothing** to npm: `cliPublishTarget` marks every bare tag `engineOnly` and `npm-publish.yml` gates its publish job on `engine_only != 'true'` (#729). Moving the `beta` dist-tag takes its own `vX.Y.Z-beta.N-cli` marker release, with `package.json#version` at that same beta SemVer — the publish job verifies the two agree. Only after that does `bun add -g @drakulavich/kesha-voice-kit@beta` deliver the CLI.
- Promote by cutting a later stable `vX.Y.Z` release; do not reuse the beta tag or try to retag it as stable.

**Alpha channel** (#685) — versions are derived from tags at publish time and never committed, so `main` carries the *next* unreleased CLI version as the alpha base:

- **CLI alphas** publish themselves. Label a PR `alpha`; on merge, `npm-publish.yml`'s `push: main` trigger runs the reusable `release-alpha.yml`, which derives `vX.Y.Z-alpha.N-cli` and pushes the tag, and the same run then publishes it. Install with `bun add -g @drakulavich/kesha-voice-kit@alpha`. The escape hatch for a PR merged without the label is `gh workflow run npm-publish.yml --ref main` with **no** `tag` input: an empty `tag` selects the alpha lane, and `alpha-requested.sh` returns `publish=true` on a manual run before either gate, label or packed-path. Passing a `tag` instead re-publishes that existing release. No GitHub Release is created for an alpha — the annotated tag carries the notes.
- A labelled PR that changed nothing npm packs publishes nothing: `alpha-publishable.ts` judges the changed paths against `npm pack --dry-run`.
- **Engine alphas** are dispatched by hand, tagged `vX.Y.Z-alpha.N` (no `-cli`), and end up **live, not draft** — an alpha behind the un-draft gate is not installable. The build still creates a draft and un-drafts it after upload: releases here are immutable, so an asset uploaded to a published release 422s. Beta keeps its draft. Verify with `kesha install --engine-version X.Y.Z-alpha.N` once the release is live — a bare engine alpha never reaches npm, so there is no channel to install from.
- An engine alpha leads the pin instead of matching it: `package.json#keshaEngine.version` may never name an alpha (#738), so pick a base above it, and leave all three version fields alone. The build writes the tag's version into `rust/Cargo.toml` in the runner, so `kesha-engine --version` reports the alpha.

**One workflow owns every publish.** npm Trusted Publishing validates the name of the workflow that *entered* the run — not the one holding `npm publish` — and a package configures exactly one. Two callers of the shared reusable therefore meant the unregistered one, alpha, 404'd on every attempt and never published at all (#732). So `npm-publish.yml` is the only entry: `release: published` for stable, `push: main` for alpha, `workflow_dispatch` for both, all landing on the same `publish` job. `release-alpha.yml` and `release-npm-publish.yml` are reusables it calls; neither can start a run. **Never give a publishing path a second entry workflow** — it fails with an opaque registry 404, not a permissions error.

**Recovering a failed CLI alpha publish.** This covers the CLI alpha lane only; an engine alpha is a `build-engine.yml` run and fails like any other engine build. There, `reserve-tag` runs *before* the publish on purpose: npm holding a version no tag records lets the next derivation reuse it, and the prior-publish guard turns that reuse into a green no-op. The cost of that ordering is the opposite failure — a publish that dies after the tag exists leaves an orphan tag, and the sequence is derived from tags alone.

| | outcome |
| --- | --- |
| re-run **failed jobs only** | `decide` outputs are kept, the same version is retried — correct |
| re-run **all jobs** | the new tag is now visible, the sequence advances, the orphan is never filled |
| do nothing | the orphan stays; later merges continue past it |

So: **re-run failed jobs only, or delete the orphan tag first.** A gap in the alpha sequence is expected and harmless — `nextSequence` only reads the highest.

**The `alpha` label is read live, not frozen at merge.** `alpha-requested.sh` calls `GET /commits/{sha}/pulls`, which returns the merged PR's *current* labels. Between merge and the `decide` job, removing the label skips the publish and adding it causes one. Treat it as a soft gate — "I removed the label right after merging" is a real explanation for a missing alpha.

```bash
gh workflow run "🔨 Build Engine" -R drakulavich/kesha-voice-kit \
  -f tag="$(bun .github/scripts/derive-alpha-version.ts engine 1.24.8 | sed -n 's/^tag=//p')" \
  -f ref=main -f notes="Engine alpha."
kesha install --engine-version 1.24.8-alpha.1   # a later plain `kesha install` restores the pin
```

**Alternate tag path:** `workflow_dispatch` validates tag shape and authors notes inline, useful when a sandbox cannot push tags:

```bash
gh workflow run "🔨 Build Engine" \
  -R drakulavich/kesha-voice-kit \
  -f tag=vX.Y.Z \
  -f ref=main \
  -f notes="$(cat release-notes.md)"
```

Because `workflow_dispatch` authors release notes inline via `-f notes`, skip engine-release step 4 when using this path.

Known break (v1.16.0, 2026-05-14): `GITHUB_TOKEN` tag pushes do not trigger downstream `on.push.tags`; dispatch ends with `tag: success, build/release: skipped`. Workaround until PAT/GitHub App token fix: fetch tags, delete the remote tag, re-push it from a maintainer laptop so a user-authored push triggers the build:

```bash
git fetch --tags
git push origin :refs/tags/vX.Y.Z
git push origin vX.Y.Z
```

## NPM PUBLISH IS AUTOMATED WITH PROVENANCE ATTESTATION

Post-#291 happy path: publishing a GitHub release runs `.github/workflows/npm-publish.yml` → `npm publish --provenance --access public` in GHA. Do not publish from a maintainer laptop unless the workflow is broken.

- Trigger: `release: published` (engine un-draft or a hand-cut `v*-cli` marker), `push: main` (the alpha lane, which now runs inline rather than dispatching), `workflow_dispatch` — with a `tag` to re-publish that release, without one to cut an alpha — and the dispatch from `release-cli.yml`. Only `-cli` tags publish a CLI; a bare tag names the engine (#729).
- One workflow *enters* every publish: npm Trusted Publishing validates the name of the entering workflow and a package configures exactly one. `release-cli.yml` therefore keeps dispatching through `dispatch-npm-publish.sh` rather than publishing itself, and `check-workflows.ts::requireNpmPublishAfterPackaging` fails the lint if that job stops doing so (#731).
- Provenance: `permissions.id-token: write` gives npm the GHA OIDC chain (`commit SHA` → built tarball) and the npm "verified" badge.
- Guards: tag must match `package.json#version` after stripping leading `v` and trailing `-cli`; already-published versions skip publish and exit 0. An alpha version is minted at publish time, so it is injected into `package.json` instead of verified against it.
- Dist-tags: resolved by `npm-dist-tag.mjs` from the prerelease identifier — stable → `latest`, `-beta.N` → `beta`, `-alpha.N` → `alpha`, and a prerelease never lands on `latest`.
- Injection rule: route `inputs.tag` / `github.event.release.tag_name` through `env:`, never directly into `run:` while the job holds `id-token: write`.
- Required secret: `NPM_TOKEN` (granular publish-only token for `@drakulavich/kesha-voice-kit`), set with `gh secret set NPM_TOKEN -R drakulavich/kesha-voice-kit`. If missing, the release remains published but the publish step fails; fix the secret and re-run rather than publishing from a laptop, which would ship without provenance and outside the workflow npm's trusted publisher accepts.
- Release implication: un-draft is the commit-to-publish point. Validate draft assets via authenticated `gh release download` before un-drafting; npm publish is effectively permanent (72 h unpublish window, noisy provenance). If validation fails before publish: delete release + tag, bump patch, retry.

## TAG NAMES ARE ONE-USE

GitHub's immutable-releases permanently reserves tag names after publish. **Broken release → bump patch version, cut new tag.** Never tag "just to test" — use `gh workflow run "🔨 Build Engine" --ref main` instead. Skipping tags is fine (we skipped `v1.0.1`).

## RELEASE CHICKEN-AND-EGG — `integration-tests-full` SKIPS ON `release/*`

`integration-tests-full` in `.github/workflows/ci.yml` downloads the RELEASED `kesha-engine` binary at the version pinned in `package.json#keshaEngine.version`. On a version-bump PR (branch `release/X.Y.Z`) that tag doesn't exist yet — HTTP 404, CI red. The job is filtered via `if: needs.changes.outputs.integration == 'true' && !startsWith(github.head_ref, 'release/')`. Don't remove that filter. If you add a new job that downloads release artifacts, use the same branch guard.

## DRAFT RELEASE ASSET URLS ARE 404 TO ANONYMOUS CLIENTS — USE `gh release download`

`build-engine.yml` creates a draft release with 3 platform binaries. Draft asset URLs 404 for unauthenticated clients, so `curl`, `kesha install`, and anonymous `make smoke-test` cannot validate the draft. Authenticated `gh release download vX.Y.Z -p "..." -D <dir>` works on drafts and is the pre-undraft release gate; `make smoke-test` is only a post-undraft sanity check, but post-#291 un-draft also triggers npm publish.

## `make smoke-test` ALONE DOES NOT VALIDATE A NEW ENGINE — `gh release download` THE DRAFT BINARY AND EXERCISE IT BEFORE `gh release edit --draft=false`

`make smoke-test` runs `bun link @drakulavich/kesha-voice-kit`, `kesha install`, then `bun scripts/smoke-test.ts`, but a prior `bun add -g` can leave the old global shim in front. Then `kesha --version` and `kesha install` exercise the previous CLI/engine and produce a false-green "6/6 passed". v1.5.0 hit this: `--capabilities-json` passed, Kokoro synth crashed (`Invalid input name: tokens`), and local smoke still routed through v1.4.4 CLI + v1.4.1 engine.

Before `gh release edit --draft=false`, always validate the draft binary directly with authenticated `gh release download`, not `curl` (drafts 404 anonymously). Un-draft starts `📦 npm Publish` within ~60 s; npm unpublish is limited/noisy, and #291's Greptile review flagged this ordering.

```bash
SMOKE=/tmp/kesha-vX.Y.Z-smoke && rm -rf "$SMOKE" && mkdir "$SMOKE" && cd "$SMOKE"
gh release download vX.Y.Z -R drakulavich/kesha-voice-kit \
  -p "kesha-engine-darwin-arm64" -D "$SMOKE"
chmod +x kesha-engine && xattr -d com.apple.quarantine kesha-engine 2>/dev/null

# 1. Version string MUST equal the new tag — sanity check
./kesha-engine --version          # → "kesha-engine X.Y.Z"

# 2. Capability surface — must include every feature the build matrix promised
./kesha-engine --capabilities-json | jq .features

# 3. Real end-to-end exercise (the one CI's --capabilities-json check misses).
#    For TTS: synthesize a known-good voice into a fresh KESHA_CACHE_DIR.
#    For ASR: transcribe a fixture from rust/tests/fixtures/.
KESHA_CACHE_DIR="$SMOKE/cache" ./kesha-engine install --tts
echo "Hello world" | KESHA_CACHE_DIR="$SMOKE/cache" \
  ./kesha-engine say --voice en-am_michael --out "$SMOKE/en.wav"
file "$SMOKE/en.wav"              # must report a valid WAV
[[ -s "$SMOKE/en.wav" ]] || { echo "ERROR: en.wav is empty — synthesis failed"; exit 1; }
# Optional belt-and-braces: enforce a minimum byte count (1s mono f32 24kHz ≈ 96 KB).
[[ $(stat -f%z "$SMOKE/en.wav" 2>/dev/null || stat -c%s "$SMOKE/en.wav") -gt 50000 ]] \
  || { echo "ERROR: en.wav is suspiciously small — header-only stub?"; exit 1; }
```

Repeat for `kesha-engine-linux-x64` (run via Docker if not on Linux). If ANY of those three steps fail, **DO NOT un-draft** — un-drafting fires `📦 npm Publish` automatically. Either yank the GitHub release (`gh release delete vX.Y.Z --yes`, delete the tag, bump patch, retry) or push a fix and rebuild via `gh workflow run "🔨 Build Engine"`. Since the draft never went public, no recall is needed.

The CI smoke step (`--capabilities-json` only) is a sanity check on the toolchain, not a behavior test. Behavior testing is the human-in-the-loop pre-undraft gate; it lives in this checklist, not in the workflow file.

## `bun link` DOES NOT OVERRIDE A GLOBALLY-INSTALLED PACKAGE — REMOVE FIRST

`bun link` in the package root only registers the local checkout; it does not replace an existing `~/.bun/install/global/node_modules/<pkg>/` created by `bun add -g`. If the old directory wins, the global `kesha` shim keeps using the previously installed CLI and old embedded `keshaEngine.version`.

Detect with `readlink ~/.bun/install/global/node_modules/@drakulavich/kesha-voice-kit`: no output means a real old directory wins; a path back to the checkout means the link wins. One-time fix:

```bash
bun remove -g @drakulavich/kesha-voice-kit   # delete the previously-installed copy
bun link                                      # re-register from package root
# verify:
readlink ~/.bun/install/global/node_modules/@drakulavich/kesha-voice-kit
# should print: /path/to/your/kesha-voice-kit checkout (absolute path)
```

Incident: `bun link` on local main still reported `kesha --version` 1.14.0, but `kesha install` said `Upgrading engine v1.14.0 → v1.6.0...`; the shim was the old `bun add -g` v1.6.0 install. `bun remove -g` + `bun link` fixed it.

## Greptile re-review & auto-merge mechanics

Greptile comment mechanics:

- It updates one existing top-level comment, not a new comment per review. Confirm re-review by checking both the "Last reviewed commit" SHA (`body | match("commit/([a-f0-9]+)")`) and the issue-comment `.updated_at`; `gh pr view --json comments` has null `updatedAt`, so use `gh api repos/OWNER/REPO/issues/<N>/comments`.
- Do not arm auto-merge before Greptile reviews the latest head; otherwise CI-green can merge before a new P1/P2 arrives (#287→#288→#289; #290→#291→#292 avoided by waiting). Merge by hand after `Confidence Score: ≥4/5` references the latest SHA.
- If Greptile is the next gate, set a real wait: `ScheduleWakeup(delaySeconds: 300-900, prompt: "<<autonomous-loop-dynamic>>", reason: "<...>")` (270s for cache-warm, 900s+ for cache miss; avoid the dead zone around 300s). Optional auto-merge poll: `while :; do gh api repos/drakulavich/kesha-voice-kit/issues/N/comments --jq '.[] | select(.user.login | contains("greptile"))'; done`, merging only when `Confidence Score: ≥4/5` and `commit/SHA` match head. If the latest head stays uncovered after the wait, leave the PR unmerged and report the stale/missing Greptile review to the maintainer. Stop the poll if the user says to wait.
