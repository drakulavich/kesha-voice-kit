# Release Runbook

> Extracted from CLAUDE.md (chore/slim-claudemd, 2026-05-31) to keep the always-loaded
> instructions under Claude Code's 40k-char performance threshold. Read this when cutting
> or publishing a release.

## RELEASE PROCESS — CLI AND ENGINE ARE VERSIONED INDEPENDENTLY

`package.json#version` (CLI) and `package.json#keshaEngine.version` (engine, mirrored in `rust/Cargo.toml`) are decoupled. `src/engine-install.ts` downloads `v${keshaEngine.version}` with fallback to `package.json#version`.

Version drift gate: `bun .github/scripts/check-versions.ts` (`bun run check:versions` / `make versions`, CI "🔢 Check version drift") enforces:

1. `keshaEngine.version === rust/Cargo.toml#version` — one engine version stored twice; drift makes `kesha install` fetch the wrong source/release.
2. `package.json#version >= keshaEngine.version` — CLI may lead for CLI-only patches, never lag.

**CLI-only patch** (docs, TS, plugin): bump only `package.json#version`; leave `keshaEngine.version` + `rust/Cargo.toml`; PR CI uses the existing engine; merge; create a marker release:

CLI-only is allowed only when the changed CLI surface works against the already-published engine pinned by `package.json#keshaEngine.version`. If a CLI command delegates to a new engine subcommand, capability flag, feature behavior, or output contract, it is an **engine release**: bump `package.json#keshaEngine.version`, `rust/Cargo.toml`, and `rust/Cargo.lock` together. Before cutting any `v*-cli` marker, smoke-test new/changed CLI commands against the published pinned engine, not only a repo-local engine build. The `v1.18.2-cli` / `v1.18.3-cli` mistake was exposing `kesha record` while the pinned published engine was still `v1.18.0` and did not implement `kesha-engine record`.

```bash
gh release create vX.Y.Z-cli --title "vX.Y.Z (CLI-only)" \
  --notes "Engine: v<keshaEngine.version> (unchanged)."
npm view @drakulavich/kesha-voice-kit version   # within ~60s, expect X.Y.Z
```

`v*-cli` is excluded from `build-engine.yml`; the published marker fires `📦 npm Publish` automatically.

**Engine release** (anything under `rust/` or an engine bump):

1. Bump `rust/Cargo.toml`, `rust/Cargo.lock` (`cargo check`), `package.json#keshaEngine.version`, usually `package.json#version`.
2. Merge to main.
3. Tag/push: `git tag vX.Y.Z && git push origin vX.Y.Z` → `build-engine.yml`.
4. Write release notes before publishing. Draft releases start with an empty body:

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
7. Publish: `gh release edit vX.Y.Z --draft=false`. This fires `📦 npm Publish`; verify `npm view @drakulavich/kesha-voice-kit version` within ~60s. Manual fallback: `npm publish --access public` from the maintainer laptop.
8. Stable `vX.Y.Z` engine releases also update `drakulavich/homebrew-tap` via `🍺 Homebrew Tap` using `HOMEBREW_TAP_TOKEN` scoped only to the tap repo, and attach Linux x64 `.deb`/`.rpm` packages covered by `SHA256SUMS` + Sigstore. CLI-only marker releases skip Homebrew/packages.

**Beta engine release** (unstable channel):

- Use SemVer prerelease versions in all three places: `package.json#version`, `package.json#keshaEngine.version`, and `rust/Cargo.toml`, for example `1.18.7-beta.1`; tag as `v1.18.7-beta.1`.
- `build-engine.yml` accepts `vX.Y.Z-beta.N`, creates a **draft prerelease**, and uploads engine binaries, sidecars, `SHA256SUMS`, manifest, SBOM, and Sigstore bundles. It intentionally skips Homebrew and Linux `.deb`/`.rpm` packages for beta tags.
- After draft asset validation, publish with `gh release edit vX.Y.Z-beta.N --draft=false`. `📦 npm Publish` publishes prerelease package versions with `npm publish --tag beta`, so `@latest` stays on the latest stable release.
- Verify beta with `npm view @drakulavich/kesha-voice-kit@beta version`; user-facing beta install is `bun add -g @drakulavich/kesha-voice-kit@beta && kesha install`.
- Promote by cutting a later stable `vX.Y.Z` release; do not reuse the beta tag or try to retag it as stable.

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

- Trigger: `release: published` (engine un-draft or published `v*-cli` marker) plus `workflow_dispatch` re-runs.
- Provenance: `permissions.id-token: write` gives npm the GHA OIDC chain (`commit SHA` → built tarball) and the npm "verified" badge.
- Guards: tag must match `package.json#version` after stripping leading `v` and trailing `-cli`; already-published versions skip publish and exit 0.
- Dist-tags: stable package versions publish to `latest`; SemVer prerelease package versions publish to `beta`.
- Injection rule: route `inputs.tag` / `github.event.release.tag_name` through `env:`, never directly into `run:` while the job holds `id-token: write`.
- Required secret: `NPM_TOKEN` (granular publish-only token for `@drakulavich/kesha-voice-kit`), set with `gh secret set NPM_TOKEN -R drakulavich/kesha-voice-kit`. If missing, the release remains published but the publish step fails; fallback is `npm publish --access public` from a laptop.
- Release implication: un-draft is the commit-to-publish point. Validate draft assets via authenticated `gh release download` before un-drafting; npm publish is effectively permanent (72 h unpublish window, noisy provenance). If validation fails before publish: delete release + tag, bump patch, retry.

## TAG NAMES ARE ONE-USE

GitHub's immutable-releases permanently reserves tag names after publish. **Broken release → bump patch version, cut new tag.** Never tag "just to test" — use `gh workflow run "🔨 Build Engine" --ref main` instead. Skipping tags is fine (we skipped `v1.0.1`).

## RELEASE CHICKEN-AND-EGG — `integration-tests` SKIPS ON `release/*`

`integration-tests` in `.github/workflows/ci.yml` downloads the RELEASED `kesha-engine` binary at the version pinned in `package.json#keshaEngine.version`. On a version-bump PR (branch `release/X.Y.Z`) that tag doesn't exist yet — HTTP 404, CI red. The job is filtered via `if: needs.changes.outputs.integration == 'true' && !startsWith(github.head_ref, 'release/')`. Don't remove that filter. If you add a new job that downloads release artifacts, use the same branch guard.

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
