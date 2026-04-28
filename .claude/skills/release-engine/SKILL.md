---
name: release-engine
description: Cuts a kesha-engine release per CLAUDE.md rules — pre-flight audits, version bump, tag, release-notes BEFORE publish, smoke-test AFTER publish, then npm publish. Refuses to auto-run; user must explicitly invoke. Knows the gh-cli release-notes trap and the draft-URL 404 trap.
disable-model-invocation: true
---

# release-engine

Cuts a kesha-engine release. **NEVER auto-runs** — user invokes via `/release-engine vX.Y.Z` (or `/release-engine vX.Y.Z-cli` for CLI-only).

## Inputs

- `$1`: target tag, e.g. `v1.4.4` (engine release) or `v1.4.4-cli` (CLI-only marker release).
- Optional: `--draft` to stop before publishing.

## Two release modes

### Mode A: CLI-only (suffix `-cli`)

For docs/TS/plugin tweaks where the engine binary is unchanged.

1. Bump only `package.json#version`. Leave `package.json#keshaEngine.version` and `rust/Cargo.toml` untouched.
2. PR through CI (integration tests reuse the existing engine binary at the pinned `keshaEngine.version`).
3. Merge.
4. `gh release create $TAG --title "$VERSION (CLI-only)" --notes "Engine: v<keshaEngine.version> (unchanged)."`
5. `npm publish --access public`

The `-cli` suffix is excluded from `build-engine.yml`'s tag filter — no Rust rebuild.

### Mode B: Engine release (no suffix, e.g. `v1.4.4`)

Anything under `rust/`, or bumping `keshaEngine.version`.

## Pre-flight checklist (run BEFORE bumping versions)

```bash
# 1. Working tree clean, on main, up to date
git status
git fetch origin && git status -sb | head -3

# 2. Feature matrix audit — every default cargo feature MUST appear in every build-engine.yml matrix row.
#    v1.1.0 shipped without TTS because the matrix drifted; v1.1.3 fixed it.
diff <(grep 'features = ' .github/workflows/build-engine.yml) <(grep '^default' rust/Cargo.toml)

# 3. CI green on main
gh run list --workflow ci.yml --branch main --limit 1
gh run list --workflow rust-test.yml --branch main --limit 1

# 4. Local sanity
cd rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings
cargo test --release
cd .. && bun test && bunx tsc --noEmit
```

If anything fails, STOP. Do not bump versions.

## Engine release procedure

### Step 1: Version bump in lockstep

Bump these THREE in the same commit:

- `rust/Cargo.toml` — `version = "X.Y.Z"`
- `rust/Cargo.lock` — refresh via `cd rust && cargo check`
- `package.json` — both `version` AND `keshaEngine.version`

```bash
cd rust && cargo check
cd ..
git diff rust/Cargo.toml rust/Cargo.lock package.json  # eyeball
git add rust/Cargo.toml rust/Cargo.lock package.json
git commit -m "chore(release): vX.Y.Z"
```

### Step 2: Merge through PR (branch `release/X.Y.Z` is fine — `integration-tests` job is filtered to skip on `release/*` since the engine tag doesn't exist yet)

```bash
git push -u origin release/X.Y.Z
gh pr create --fill --base main
# wait for green
gh pr merge --squash --delete-branch
```

### Step 3: Tag + push (triggers build-engine.yml)

```bash
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

`build-engine.yml` builds 3 platform binaries, smoke-tests each with `--capabilities-json`, creates a **DRAFT** release with EMPTY body.

### Step 4: WRITE RELEASE NOTES — BEFORE PUBLISHING

⚠️ **CRITICAL:** `gh release edit --notes` silently drops content on PUBLISHED releases (gh CLI quirk, not GitHub limitation). Author the notes WHILE the release is still a draft.

Template (modeled on v1.1.3):

```markdown
## Highlights
- <new feature 1>
- <new feature 2>

## Platform support
- macOS arm64 (CoreML)
- macOS arm64 / x64 (ONNX)
- Linux x64 (ONNX)
- Windows x64 (ONNX)

## Breaking changes
- <if any; otherwise omit>

## Shipped PRs
- #N — title
- ...

## Follow-up issues
- #N — title
- ...

## Upgrade
```bash
bun install -g @drakulavich/kesha-voice-kit@X.Y.Z
kesha install
```
```

Apply:

```bash
gh release edit vX.Y.Z --notes "$(cat <<'EOF'
<your notes>
EOF
)"
```

**If you forgot and already published:** the only escape hatch is a direct API PATCH (gh's `--notes` is silently ignored on published releases due to `immutable: true` on tag/assets, NOT body — but gh treats it as immutable anyway).

```bash
RELEASE_ID=$(gh api repos/drakulavich/kesha-voice-kit/releases/tags/vX.Y.Z --jq '.id')
jq -Rs '{body: .}' < notes.md > body.json
gh api -X PATCH "repos/drakulavich/kesha-voice-kit/releases/$RELEASE_ID" --input body.json
```

### Step 5: Publish the draft

```bash
gh release edit vX.Y.Z --draft=false
```

⚠️ Draft release asset URLs return **HTTP 404** to unauthenticated clients. `make smoke-test` and `kesha install` will fail against a draft. Smoke-test must run AFTER publish.

### Step 6: Smoke test

```bash
make smoke-test
```

Verifies each platform binary downloads + executes correctly.

If smoke fails: **DO NOT** publish to npm. Investigate. The release can be re-drafted with `gh release edit vX.Y.Z --draft=true`, fixed via re-tag of a NEW version (tags are immutable — never reuse vX.Y.Z), and re-published.

### Step 7: npm publish

```bash
npm publish --access public
```

### Step 8: Verify install end-to-end

```bash
npx -y @drakulavich/kesha-voice-kit@X.Y.Z --version
npx -y @drakulavich/kesha-voice-kit@X.Y.Z install
npx -y @drakulavich/kesha-voice-kit@X.Y.Z <fixture.ogg>
```

## Hard rules (from CLAUDE.md)

- NEVER reuse a tag name. Bump patch instead of "tagging just to test" — use `gh workflow run "🔨 Build Engine" --ref main` for test builds.
- NEVER skip pre-commit hooks (`--no-verify`).
- NEVER force-push to main.
- NEVER `npm publish` if smoke-test failed.
- NEVER write release notes AFTER publishing — gh silently drops them.
- ALWAYS verify the build-engine.yml feature matrix matches `rust/Cargo.toml` `default = [...]` before tagging.

## Output

At the end, print:

```
🎉 Released vX.Y.Z
- GitHub: https://github.com/drakulavich/kesha-voice-kit/releases/tag/vX.Y.Z
- npm:    https://www.npmjs.com/package/@drakulavich/kesha-voice-kit/v/X.Y.Z
- npm tag: latest

Smoke: <macos-coreml ✓ | linux-onnx ✓ | windows-onnx ✓>
```

## On failure

If any step fails partway through, report:
- Last successful step
- The failing command + output
- Recovery hint (most common: re-run smoke after `gh release edit --draft=false`)
