---
name: release-cli
description: Cuts a CLI release (vX.Y.Z-cli marker tag) — the `🚀 Release (CLI)` lane builds the Linux packages, publishes the marker release, and dispatches npm publish with provenance. Covers version alignment across package.json and server.json, why the tag must be pushed by a human, and how to verify from the registry rather than through a stale global install. Refuses to auto-run; user must explicitly invoke. For an engine release use release-engine.
disable-model-invocation: true
---

# release-cli

Cuts a **CLI** release. **NEVER auto-runs** — user invokes via `/release-cli vX.Y.Z-cli`.

For an engine release (bare `vX.Y.Z`, GitHub Release only) use the **`release-engine`** skill. A full ship is `/release-engine` first, then this one: the CLI release is what carries the new engine pin to users, and what ships the Linux packages.

## Inputs

- `$1`: target tag, e.g. `v1.27.0-cli`. The `-cli` marker routes it: `build-engine.yml` excludes it, `release-cli.yml` claims it.

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
gh release view "v$(node -p "require('./package.json').keshaEngine.version")" --json isDraft,isPrerelease

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

### Step 3 — Write the notes, then push the tag

The lane creates the release itself, so the notes go on afterwards **while it is still a draft** — or, more simply, be ready to add them the moment the release appears. `gh release edit --notes` silently drops content on an already-published release.

```bash
git tag vX.Y.Z-cli
git push origin vX.Y.Z-cli
```

Notes should say where the engine pin landed. "Engine unchanged" is only true when it is; if the pin moved, that movement is the headline, because it is how the new engine reaches users. User-facing upgrade text says **bun**, never npm: `bun add -g @drakulavich/kesha-voice-kit@latest`.

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
bun add @drakulavich/kesha-voice-kit@X.Y.Z
export KESHA_ENGINE_BIN="$PWD/eng/kesha-engine"
./node_modules/.bin/kesha --version         # X.Y.Z
./node_modules/.bin/kesha install           # must fetch the pinned engine
./node_modules/.bin/kesha <fixture>.ogg
```

**`make smoke-test` can false-green here.** It runs whatever `kesha` resolves to, and a previously `bun add -g`'d install outranks `bun link`; if its output prints an older version, it tested an older CLI and proves nothing about this release.

## Hard rules

- NEVER `npm publish` from a laptop — GHA owns it, with provenance.
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
