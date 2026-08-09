---
name: release-engine
description: Cuts a kesha-engine release (bare vX.Y.Z tag) per CLAUDE.md rules — pre-flight audits, engine-only version bump, annotated tag carrying the notes, draft validation with authenticated download, publish, then verify. Refuses to auto-run; user must explicitly invoke. Knows the workflow-frozen-at-the-tag trap, the gh-cli release-notes trap, and the draft-URL 404 trap. For a CLI release use release-cli.
disable-model-invocation: true
---

# release-engine

Cuts a **kesha-engine** release. **NEVER auto-runs** — user invokes via `/release-engine vX.Y.Z`.

For a CLI release (`vX.Y.Z-cli`, npm) use the **`release-cli`** skill instead. The two are independent version lines; a full ship is usually `/release-engine` then `/release-cli`.

## Inputs

- `$1`: target tag, e.g. `v1.24.9`. Bare — no `-cli` suffix. `-beta.N` / `-alpha.N` are prerelease shapes; alphas are dispatched, not tagged by hand (see `release-mechanics`).

## THE TRAP THAT COSTS A TAG

**The workflow GitHub runs for a tag is the one stored *at that tag*.** A fix merged to `main` afterwards cannot rescue it, and re-running the failed job re-runs the broken definition. If the release job fails for a reason living in the workflow itself, that tag is dead — tag names are one-use, so you bump the patch and cut a new one. (v1.24.8 was lost exactly this way.)

Corollary: when the workflow on `main` is already fixed but a tag is not, release via `workflow_dispatch --ref main`, which runs main's definition:

```bash
gh workflow run "🔨 Build Engine" -R drakulavich/kesha-voice-kit \
  -f tag=vX.Y.Z -f ref=main -f notes="$(cat notes.md)"
```

## Pre-flight (run BEFORE bumping versions)

```bash
# 1. Root checkout clean, on main, up to date. Edit in a worktree, never here.
git fetch origin main && git status -sb | head -3

# 2. Every additive cargo default in every matrix row — v1.1.0 shipped without TTS when this drifted.
grep -E '^\s+features:' .github/workflows/build-engine.yml
grep '^default =' rust/Cargo.toml

# 3. CI green on main
gh run list --workflow ci.yml --branch main --limit 1
gh run list --workflow rust-test.yml --branch main --limit 1

# 4. Local sanity — nextest, not `cargo test` (CLAUDE.md)
cargo fmt --check --manifest-path rust/Cargo.toml
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
cargo check --manifest-path rust/Cargo.toml --features coreml --no-default-features
make rust-test
bunx tsc --noEmit && bun test && bun run check:versions
```

If anything fails, STOP. Do not bump versions. A `bun test` failure that does not reproduce on a second run is the documented timing flake — confirm against CI on the same SHA rather than chasing it.

## Procedure

### Step 1 — Version bump, engine fields ONLY

In a worktree (`git worktree add .worktrees/release-X.Y.Z -b release/X.Y.Z origin/main`), bump three fields in one commit:

- `rust/Cargo.toml` — use `node .github/scripts/set-cargo-version.mjs X.Y.Z`, which rewrites only the `[package]` version. **It resolves paths from the current directory** — run it from inside the worktree or it edits the root checkout.
- `rust/Cargo.lock` — refresh with `cd rust && cargo check`
- `package.json#keshaEngine.version` — **not** `package.json#version`

`main` carries the next *unreleased* CLI version since #691; dragging it down would publish that as npm `latest` and downgrade every user (#729). An engine tag publishes no npm package — users get the engine when a `-cli` release ships the bumped pin.

**Raise, never lower.** If the engine version would overtake `package.json#version`, raise the CLI line to match in the same commit: `check:versions` rule 2 requires `cli >= engine`.

### Step 2 — Merge through a PR on `release/X.Y.Z`

The branch name matters twice: `integration-tests-full` skips on `release/*` (it downloads the *published* engine, whose tag does not exist yet), and `check-engine-targets` skips its 404 check there — that is the documented window between the release merge and its tag.

That window must stay short. While it is open, `main` pins an engine with no release, so `check-engine-targets` fails any PR that reaches `workflow-lint` — anything touching workflow-shaped paths, plus the scheduled run.

### Step 3 — Tag with the notes inside it

Write the notes first, then create an **annotated** tag whose message is the notes. `build-engine.yml` reads the annotation into the draft body via `engine-release-notes.mjs`, so this sidesteps the published-release notes trap entirely.

```bash
git tag -a vX.Y.Z --cleanup=verbatim -F notes.md
git push origin refs/tags/vX.Y.Z
```

`--cleanup=verbatim` keeps the `#` heading lines a release body needs; git's default cleanup strips every line starting with `#`. The `-a` is equally load-bearing: a lightweight tag carries no annotation, and the notes are dropped with a `::notice::` rather than published — before #815 the lane read `%(contents)` unguarded and shipped the *commit* message as the release body instead. Do **not** run `.github/scripts/push-annotated-tag.sh` locally — it sets `user.name`/`user.email` to github-actions[bot] in the repo config, which is right in CI and wrong on a laptop.

The build produces 3 platform binaries, smoke-tests each with `--capabilities-json`, and creates a **draft** release with SBOM, manifest, `SHA256SUMS` and Sigstore bundles. Engine tags do **not** attach Linux `.deb`/`.rpm` — those ship on the `-cli` marker release now (#728).

Expect `Darwin synthesis smoke (advisory)` to fail — it is `continue-on-error` and tracked as #742 / #678.

### Step 4 — Validate the draft before publishing

Draft asset URLs return **404 to unauthenticated clients**, so `curl` and `make smoke-test` can false-green through a stale global install. Download with `gh`:

```bash
gh release download vX.Y.Z -p 'kesha-engine-darwin-arm64' -p 'SHA256SUMS' -p 'kesha-release-manifest.json'
chmod +x kesha-engine-darwin-arm64
./kesha-engine-darwin-arm64 --version          # must equal X.Y.Z
shasum -a 256 -c SHA256SUMS --ignore-missing
./kesha-engine-darwin-arm64 --capabilities-json | jq '.backend, (.features|length)'
```

Compare the feature list against the previous release: a silently missing feature is the v1.1.0 failure mode, and the count is the cheapest way to catch it.

**A capabilities probe is not enough.** v1.5.0 reported itself healthy and could not synthesise. Actually exercise the binary before un-drafting — transcribe a fixture and synthesise a line — and verify a signature while you are there:

```bash
export KESHA_ENGINE_BIN="$PWD/kesha-engine-darwin-arm64"
bun run bin/kesha.js tests/fixtures/benchmark-en/01-check-email.ogg
bun run bin/kesha.js say "release check" --out /tmp/check.wav
cosign verify-blob --bundle kesha-engine-darwin-arm64.sigstore.json \
  --certificate-identity "https://github.com/drakulavich/kesha-voice-kit/.github/workflows/build-engine.yml@refs/tags/vX.Y.Z" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  kesha-engine-darwin-arm64
```

### Step 5 — Publish

```bash
gh release edit vX.Y.Z --draft=false
```

Un-drafting a **bare** engine tag publishes nothing to npm — `npm-publish.yml` skips its publish job on `engine_only` (#729). It does fire `release: published`, which starts **`🍺 Homebrew Tap`** for stable tags, so the blast radius is the GitHub release plus the tap.

### Step 6 — Verify against the published release

**`make smoke-test` is not sufficient on its own.** It runs whatever `kesha` resolves to, and a previously `bun add -g`'d install outranks `bun link` — a run that prints an old version tested an old CLI. Verify the real artifact in an isolated path:

```bash
SMOKE=$(mktemp -d) && export KESHA_ENGINE_BIN="$SMOKE/kesha-engine"
bun run bin/kesha.js install          # must report the new engine version
bun run bin/kesha.js tests/fixtures/benchmark/09-ustanovi-poka-klod-kod.ogg
```

This re-downloads from the published release rather than re-using the draft binary from step 4 — which is the point: it exercises what a user gets.

Then hand off to **`/release-cli`** so the pin reaches users.

## Hard rules

- NEVER reuse a tag name. Broken release → bump patch, new tag. For test builds use `gh workflow run "🔨 Build Engine" --ref main` with no tag.
- NEVER skip pre-commit hooks (`--no-verify`) or force-push to `main`.
- NEVER write release notes after publishing — `gh release edit --notes` silently drops them.
- ALWAYS check the feature matrix against cargo's defaults before tagging.
- ALWAYS leave the root checkout on `main`; edit in a worktree.

## Output

```
🎉 Released vX.Y.Z
- GitHub: https://github.com/drakulavich/kesha-voice-kit/releases/tag/vX.Y.Z
- Assets: <n> (engine ×3, sidecars ×2, SBOM, manifest, SHA256SUMS, Sigstore bundles)
- Engine reports: X.Y.Z   Checksums: OK   Features: <n> (unchanged vs previous)

Next: /release-cli vA.B.C-cli to ship the pin to npm.
```

## On failure

Report the last successful step, the failing command and its output, and whether the tag is still usable. If the failure lives in the workflow stored at the tag, say so plainly: that tag cannot be rescued and the fix ships under the next patch number.
