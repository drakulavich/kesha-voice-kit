---
name: release
description: Cuts a Kesha release through release.yml — a stable vX.Y.Z tag, a dispatched beta, or an alpha — and explains the release machinery. One version names the CLI and the Engine. Covers the version bump, the annotated tag, what the run publishes and in what order, how to verify from the registry, re-recording the capability pacts, and recovery. Refuses to auto-run; the maintainer invokes it explicitly.
disable-model-invocation: true
---

# release

Cuts a release. **Never auto-runs**: the maintainer invokes `/release vX.Y.Z` (stable), `/release beta X.Y.Z-beta.N` or `/release alpha`. Pushing a tag and dispatching `release.yml` publish immediately and permanently; an agent does neither unless the maintainer asks in this conversation.

## The model

- **One version.** `package.json#version` names the CLI and the Engine; `rust/Cargo.toml`, `rust/Cargo.lock` and both `server.json` versions mirror it (`bun run check:versions`). `main` carries the next unreleased version: the `post-release` job opens a PR that leads it to the next minor after every stable release.
- **One workflow.** `.github/workflows/release.yml` classifies the trigger (`release-classify.ts`). `plan` gates the run; `build` has three rows, one Cargo profile each, followed by `darwin-synthesis-smoke` and `roundtrip-smoke`. The stable-only `packages` job runs alongside those jobs. `assemble` waits for the build, smokes, and (on stable) packages; then `github-release` and `npm` packaging can run in parallel. `npm-publish` waits for both, followed by `npm-smoke`. Stable `homebrew` and `docker` jobs start after `github-release` and can overlap the npm smoke; stable `post-release` waits for both the GitHub release and npm smoke. A pull request that touches it runs the build and smoke rehearsal and publishes nothing.
- **The Engine pin is injected, never committed.** `npm` writes `package.json#kesha.engine = { version, sha256, size }` from the release's `SHA256SUMS` and asset list (`engine-pin.ts`); `kesha install` refuses a download that does not match it. A source checkout carries no pin and verifies against the release's own `SHA256SUMS`.
- **Releases are immutable and tag names one-use.** A release is published once, with every asset, by `github-release`; nothing is drafted. A broken release is fixed by the next patch, never by reusing its tag. Never tag to test: open a PR that touches `release.yml` for a rehearsal.
- **npm Trusted Publishing names `release.yml`.** It is the only workflow that publishes, and the package trusts exactly one workflow; a second entry point 404s at the registry (#732).

| Channel | Trigger | Publishes | npm dist-tag |
| --- | --- | --- | --- |
| stable | `just release-tag vX.Y.Z notes.md` | Engine, Linux packages, `SHA256SUMS`, manifest, SBOM, Sigstore bundles, npm, Homebrew tap, Docker image | `latest` |
| beta | `gh workflow run release.yml -f channel=beta -f version=X.Y.Z-beta.N`, or a pushed `vX.Y.Z-beta.N` tag on a commit whose `package.json#version` is that beta | Engine Prerelease, npm | `beta` |
| alpha, per merge | a merged PR labelled `alpha` that changed what npm packs | npm only, against the newest stable Engine; the tag records it | `alpha` |
| alpha, dispatched | `gh workflow run release.yml -f channel=alpha [-f engine-prerelease=vX.Y.Z-beta.N]` | Without `engine-prerelease`: Engine Prerelease and npm. With it: npm only, pinned to the named Engine | `alpha` |

A dispatched beta's `X.Y.Z` must equal `package.json#version`. An alpha version is derived from tags inside the publish queue and is never committed; a pushed `-alpha.N` tag starts nothing. The `alpha` label is read live from the merged PR, so removing it before `plan` runs skips the publish. Engine alpha Prereleases are pruned by `🌙 Nightly` after 30 days; their tags stay.

## Stable release

1. **Pre-flight.** On fresh `origin/main`: `just check`, CI green on the head, no open P1/P2 on the last merged PRs. `gh release view vX.Y.Z` must 404: the name is unused.
2. **Version.** If `package.json#version` is not already `X.Y.Z`, open a PR in a worktree that sets it in `package.json`, both `server.json` fields, `rust/Cargo.toml` and `rust/Cargo.lock` (`cargo check`), and merge it. `release-classify.ts` refuses a tag whose version differs from `package.json#version` at that commit.
3. **Notes.** Write `notes.md`: features, platform changes, breaking changes, merged PRs, follow-ups, and the upgrade command `bun add -g @drakulavich/kesha-voice-kit@latest`. The annotation becomes the release body (`engine-release-notes.mjs`); a lightweight tag contributes none.
4. **Tag.** From the clean root checkout: `just release-tag vX.Y.Z notes.md`. It tags `origin/main`, pushes, reads the tag back and waits for the push-triggered `release.yml` run ([runbook](../../../docs/runbooks/release-tag-helper.md)). The tag must be pushed by a person: a `GITHUB_TOKEN` push triggers nothing.
5. **Watch.** `gh run watch <id> --exit-status`. Every job must succeed; `homebrew` needs the `HOMEBREW_TAP_TOKEN` secret.
6. **Verify from the registry, not a global install.** A previous `bun add -g` outranks `bun link`, so a local run can test an old CLI:

   ```bash
   npm view @drakulavich/kesha-voice-kit@X.Y.Z kesha.engine.version   # X.Y.Z
   SMOKE=$(mktemp -d) && cd "$SMOKE" && bun add @drakulavich/kesha-voice-kit@X.Y.Z
   KESHA_CACHE_DIR="$SMOKE/cache" KESHA_ENGINE_BIN="$SMOKE/kesha-engine" bunx kesha install
   KESHA_CACHE_DIR="$SMOKE/cache" KESHA_ENGINE_BIN="$SMOKE/kesha-engine" bunx kesha say "Hello" > hello.wav
   ```

   `release.yml`'s smokes run on hosted runners, and hosted macOS has no Neural Engine, so darwin-arm64 Transcription is only ever verified here, on real hardware.
7. **Re-record the capability pacts.** `tests/fixtures/capabilities/*.json` describe the previous Engine until re-recorded; otherwise the weekly pact job fails on all three targets (#1246–#1248). Run `🌙 Nightly` with `job: capability-pact` and `record: true`, download the three artifacts, copy the six files over `tests/fixtures/capabilities/` unchanged in a worktree, and merge that PR. Only when the release really changed a published contract do the test's expected lists and `docs/errors.md` move with it.
8. **Merge the `post-release` PR**, which leads `main` to the next minor.

## Recovery

| State | Recovery |
| --- | --- |
| Failed before `github-release` | Nothing is public. Fix on `main`, then tag the next patch: the tag name is spent once pushed. |
| `github-release` succeeded, a later job failed | Re-run the failed jobs: `npm-publish` no-ops on a version already on npm, and the downstream jobs are idempotent. |
| The fix lives in `release.yml` itself | A re-run uses the workflow stored at the tag, so the fix ships under the next patch. |
| A per-merge alpha failed after `reserve-tag` | Re-run failed jobs only. Re-running all jobs derives the next number and leaves a gap, which is harmless. |

npm publish is effectively permanent (72 h unpublish window). Never publish from a laptop: it ships without provenance and outside the trusted publisher.

## Reference

- `integration-tests-full` and the other published-Engine lanes in `ci.yml` resolve the newest stable Engine, so a release follow-up merge gets the same path-filtered coverage as any other pull request or push to `main`.
- Greptile updates one top-level comment. Confirm a re-review through its "Last reviewed commit" SHA and the issue comment's `updated_at` (`gh api repos/drakulavich/kesha-voice-kit/issues/<N>/comments`). Gate on findings, never on its confidence score.
- Where each path installs from, and the release manifest: [docs/distribution.md](../../../docs/distribution.md).
