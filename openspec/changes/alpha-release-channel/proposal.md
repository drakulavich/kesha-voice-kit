## Why

Today the only way to exercise a change end to end is to cut a stable release: bump versions by hand, push a tag, wait for a draft, un-draft it, and accept that the tag name is burned forever and the npm publish is irreversible. That cost means changes reach a real install only in batches, and the release path itself — the part most likely to break — is exercised once per release rather than continuously.

Maks wants to run a feature on his own laptop the way a user would, before it is blessed. Ira wants the release pipeline proven on every merge, not on release day.

## What Changes

- Introduce an **alpha channel** alongside the existing stable channel. Alpha builds are Prereleases: opt-in, never served to `bun add -g @drakulavich/kesha-voice-kit` without an explicit channel selector.
- **CLI alphas publish continuously** — every push to `main` that touches CLI sources produces an npm publish under a dedicated `alpha` dist-tag. Installable as `bun add -g @drakulavich/kesha-voice-kit@alpha`.
- **Engine alphas publish on demand** — a manually dispatched build produces a Prerelease GitHub Release whose tag matches the Engine version the CLI resolves. A four-platform Rust build is too expensive to run per merge, and the Engine changes far less often than the CLI.
- **Alpha version strings are computed, never hand-edited.** No version-bump commit precedes an alpha; the pipeline derives the version from existing tags and injects it at publish time.
- **Alpha and stable share one publish path.** The steps that publish to npm become a single reusable unit invoked by both channels, so an alpha exercises the real mechanism rather than a parallel imitation.
- The npm dist-tag resolver gains a third outcome: `alpha` for `-alpha.` versions, `beta` for other Prereleases, `latest` for stable. Today every Prerelease collapses onto `beta`.
- `main` carries the next unreleased version, so an alpha has an unambiguous base to attach a sequence to.
- Alpha GitHub Releases are pruned on an age policy, so the release list stays readable at Tolaria-like cadence (18 alphas in a single day is normal there).

## Capabilities

### New Capabilities

- `release-channels`: how a build reaches a user — which channels exist, what each promises about stability, how a channel is selected at install time, how alpha versions are derived and ordered, and which guarantees hold on alpha versus stable.

### Modified Capabilities

- `installation`: the pre-release verification requirement currently reads as if every published Engine asset carries the same end-to-end proof. Alpha Engine assets are published without waiting for the full published-asset smoke lane, so the requirement needs to state what verification an alpha carries and how an alpha is distinguished from a verified stable asset.

## Non-goals

- Not changing how stable releases are cut. The draft → validate → un-draft gate stays exactly as documented.
- Not making alphas the default for any install command, hint, or documentation entry point.
- Not promoting an alpha to stable automatically. A stable release remains a deliberate, human-initiated act.
- Not introducing a beta channel workflow. The `beta` dist-tag keeps its current meaning and is out of scope here.
- Not adding an in-CLI self-updater or update-check. Channel selection stays a package-manager concern.
- Not publishing alphas from a laptop. Publishing stays in GitHub Actions with provenance, as today.

## Impact

- **Workflows**: `.github/workflows/npm-publish.yml` (publish steps extracted into a reusable workflow; dist-tag resolver extended), `.github/workflows/build-engine.yml` (alpha tags publish as non-draft Prereleases rather than drafts), plus a new alpha workflow triggered on pushes to `main`.
- **Version machinery**: a new version-computation script with unit tests; `.github/scripts/check-versions.ts` already understands Prerelease semver and should keep passing unchanged.
- **Engine resolution**: none expected. `src/engine-install.ts` builds the asset URL as `v${engineVersion}`, so an alpha Engine tag resolves with no code change — this needs confirming, not modifying.
- **CI interaction**: lanes that download the published Engine must stay pinned to the stable channel, or alpha Engine tags will start failing unrelated pull requests.
- **Release hygiene**: alpha tags accumulate quickly and GitHub reserves tag names permanently; the pruning policy applies to Releases, and its interaction with tag retention needs stating.
- **Docs**: the release runbook and the `release-mechanics` skill gain an alpha section; user-facing install text continues to say bun, never npm.
