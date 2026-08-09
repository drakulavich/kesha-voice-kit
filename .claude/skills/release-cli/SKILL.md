---
name: release-cli
description: Cuts a STABLE CLI release (vX.Y.Z-cli marker tag; not for beta or alpha markers, which this lane silently skips while burning the tag) — the `🚀 Release (CLI)` lane builds the Linux packages, publishes the marker release, and dispatches npm publish with provenance. Covers version alignment across package.json and server.json, why the tag must be pushed by a human, and how to verify from the registry rather than through a stale global install. Refuses to auto-run; user must explicitly invoke. For an engine release use release-engine.
disable-model-invocation: true
---

# release-cli

Cuts a **CLI** release. **NEVER auto-runs** — user invokes via `/release-cli vX.Y.Z-cli`.

For an engine release (bare `vX.Y.Z`, GitHub Release only) use the **`release-engine`** skill. A full ship is `/release-engine` first, then this one: the CLI release is what carries the new engine pin to users, and what ships the Linux packages.

## Inputs

- `$1`: target tag, e.g. `v1.27.0-cli`. The `-cli` marker routes it: `build-engine.yml` excludes it, `release-cli.yml` claims it.

**Stable versions only.** `cli-release-plan.mjs` returns `packages: false` for anything with a prerelease identifier, which skips the packages job and — because `publish-npm` needs it — the npm dispatch too. A `v1.28.0-beta.1-cli` tag therefore does nothing at all while permanently consuming the name. Betas go through the legacy hand-cut path in `release-mechanics`; alphas have their own lane and no GitHub release.

## What the tag sets off

Pushing `vX.Y.Z-cli` runs `🚀 Release (CLI)`, which in one run:

1. classifies the tag and **refuses one that already has a release**;
2. builds and verifies the Linux `.deb`/`.rpm`;
3. creates the marker release as a **draft** carrying those packages plus `SHA256SUMS`, then un-drafts it;
4. dispatches `📦 npm Publish` and waits for it, then verifies the version is on npm.

Steps 2–4 must happen together: the `.deb` is named from `package.json#version`, and nothing downstream re-checks that npm ever served it since #727 removed the assertion that did.

**A human has to push the tag.** A `GITHUB_TOKEN` push fires no `on.push.tags` — which is exactly why the alpha lane's own `-cli` tags never reach this workflow, alphas having no GitHub release by design.

**Do not `npm publish` from a laptop.** `npm-publish.yml` is the one entry workflow npm's trusted publisher accepts (#731), and it publishes with provenance from an OIDC identity. Un-drafting from a workflow raises no `release: published`, so the dispatch is explicit rather than cascading.

**Cut one stable CLI release at a time.** `npm-publish.yml`'s `concurrency: queue: max` serialises runs but does not order them by version, so two stable markers in flight can finish out of order and leave `latest` on the older one.

## Pre-flight

```bash
# 1. Root checkout clean, on main, up to date. Edit in a worktree, never here.
git fetch origin main && git status -sb | head -3

# 2. Version fields agree, and the pinned engine is a published, non-draft release
bun run check:versions
node -p "require('./package.json').version"
python3 -c "import json;d=json.load(open('server.json'));print(d['version'], d['packages'][0]['version'])"
gh release view "v$(node -p "require('./package.json').keshaEngine.version")" --json isDraft --jq 'if .isDraft then error("engine pin is still a draft") else "pin published" end'

# 3. CI green on main
gh run list --workflow ci.yml --branch main --limit 1

# 4. Local sanity
bunx tsc --noEmit && bun test
```

Two things sink a run if they are wrong:

- **`package.json#version` at the tag must be exactly the version the tag names.** The lane refuses otherwise, because the packages carry that field.
- **The engine pin must name a published release.** Shipping a CLI whose pin 404s means `kesha install` fails for every new user.

If anything fails, STOP.

## Procedure

### Step 1 — Align the versions (often already done)

Three fields must equal the target version: `package.json#version`, `server.json#version`, `server.json#packages[0].version`. Leave `keshaEngine.version` and `rust/Cargo.toml` alone — that is the engine line.

Since #691 `main` carries the next unreleased CLI version, so these are frequently **already** at the target and there is nothing to bump. Then skip to step 3: no diff, no PR.

`server.json` is the MCP registry manifest, and `check:versions` rule 4 requires the match — its version tells registries which npm release to resolve.

### Step 2 — Merge through a PR (only if step 1 changed something)

Branch `release/X.Y.Z`; `integration-tests-full` skips on `release/*`.

### Step 3 — Push the tag

```bash
git tag vX.Y.Z-cli
git push origin vX.Y.Z-cli
```

**The lane writes the release body itself, and there is no draft window to slip notes into.** `publish-cli-release.sh` runs `gh release create --draft … --notes "v$VERSION (CLI-only). Engine: v$ENGINE_VERSION (unchanged)."` and un-drafts it in the next line of the same script.

That body is hardcoded, so it says **"(unchanged)" even when this release is the one carrying a new engine pin** — the case that most deserves a headline. When the pin moved, replace the body after the fact; `gh release edit --notes` is silently dropped on a published release, so it takes the API:

```bash
RELEASE_ID=$(gh api repos/drakulavich/kesha-voice-kit/releases/tags/vX.Y.Z-cli --jq .id)
jq -Rs '{body: .}' < notes.md > body.json
gh api -X PATCH "repos/drakulavich/kesha-voice-kit/releases/$RELEASE_ID" --input body.json
```

User-facing upgrade text says **bun**, never npm: `bun add -g @drakulavich/kesha-voice-kit@latest`.

### Step 4 — Watch the lane

```bash
gh run list --workflow release-cli.yml --limit 1
gh run list --workflow npm-publish.yml --limit 1
npm dist-tag ls @drakulavich/kesha-voice-kit
```

`npm-dist-tag.mjs` derives the tag from the SemVer prerelease identifier: stable → `latest`, `-beta.N` → `beta`, `-alpha.N` → `alpha`. A prerelease never lands on `latest`.

If the run dies between `create --draft` and `--draft=false` it leaves a draft that blocks a re-run; the failing run prints the recovery, and `gh release view vX.Y.Z-cli` tells you the state directly. The full recovery table lives in **`release-mechanics`**.

### Step 5 — Verify from the registry, not from the repo

```bash
npm view @drakulavich/kesha-voice-kit@X.Y.Z --json | jq '.dist.attestations.provenance.predicateType'
npm pack @drakulavich/kesha-voice-kit@X.Y.Z && tar -xzOf *.tgz package/package.json | jq '.version, .keshaEngine.version'
```

Then install it somewhere isolated and run it — a fresh directory with `KESHA_ENGINE_BIN` pointing inside it, never the global install:

```bash
V=$(mktemp -d) && cd "$V"          # never in the repo: bun add here rewrites package.json
bun add @drakulavich/kesha-voice-kit@X.Y.Z
export KESHA_ENGINE_BIN="$V/eng/kesha-engine"
./node_modules/.bin/kesha --version         # X.Y.Z
./node_modules/.bin/kesha install           # must fetch the pinned engine
./node_modules/.bin/kesha <repo>/tests/fixtures/benchmark/09-ustanovi-poka-klod-kod.ogg
```

**`make smoke-test` can false-green here.** It runs whatever `kesha` resolves to, and a previously `bun add -g`'d install outranks `bun link`; if its output prints an older version, it tested an older CLI and proves nothing about this release.

### Step 6 — Re-lead the base version on `main`

`main` must carry the next *unreleased* CLI version (#691), and this release just consumed the current one. Open a follow-up PR bumping `package.json#version`, `server.json#version`, and `server.json#packages[0].version` to the next minor. Skipping this step is how #802 happened: the alpha derivation kept emitting `X.Y.Z-alpha.N` for an already-released `X.Y.Z`, so the next labelled merge would point `@alpha` at a version older than `@latest`.

## Hard rules

- NEVER `npm publish` from a laptop — GHA owns it, with provenance.
- NEVER push a `-beta.N-cli` or alpha marker through this lane; it no-ops and burns the tag.
- NEVER hand-cut `gh release create vX.Y.Z-cli`. The release would carry no packages, and `assert-release-absent.sh` then blocks the lane on that tag forever.
- NEVER let a bot push the marker tag; a token push triggers nothing.
- NEVER reuse a tag name; GitHub reserves them permanently.
- NEVER write release notes after the release is published.
- NEVER ship a CLI whose `keshaEngine.version` has no published release.
- User-facing install/upgrade text says bun, never npm.

## Output

```
🎉 Released X.Y.Z
- GitHub: https://github.com/drakulavich/kesha-voice-kit/releases/tag/vX.Y.Z-cli
- npm:    https://www.npmjs.com/package/@drakulavich/kesha-voice-kit/v/X.Y.Z
- dist-tag: latest        Provenance: yes
- Linux packages: .deb + .rpm on the marker release
- Engine pin: A.B.C (verified published)

Verified from the registry: version ✓ pin ✓ install ✓ transcribe ✓
```

## On failure

Report the last successful stage of the lane and what `gh release view vX.Y.Z-cli` shows. A draft left behind blocks a re-run and must be resolved before retrying. If npm already has the version, it is spent: fix forward under the next patch rather than unpublishing by reflex.
