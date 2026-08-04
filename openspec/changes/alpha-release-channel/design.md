## Context

Kesha ships two artifacts on independent version lines: the CLI to npm, and the Engine as
GitHub Release assets that the CLI resolves by URL. Both reach users only through a manual
gate — bump versions, push a tag, wait for a draft, validate it, un-draft, which fires
`npm publish --provenance`. Tag names are one-use and un-drafting is effectively permanent,
so the gate is deliberately heavy.

The reference implementation for the behaviour we want is `refactoringhq/tolaria`, which
publishes an alpha on every push to `main` — 18 in a single day is normal there. Its scheme
has four properties worth copying:

1. `.github/workflows/release.yml` triggers on push to `main`, with `paths-ignore` for docs,
   site, and the workflow itself.
2. `scripts/release-version.mjs` derives the version from existing tags; the workflow runs
   `node --test scripts/release-version.test.mjs` before trusting it. No version-bump commits.
3. `release-build-artifacts.yml` is a reusable workflow called by both the alpha and stable
   workflows, so an alpha exercises the real build.
4. Channels are separated at the distribution layer — a distinct `alpha-latest.json` feed
   means alpha users and stable users never collide.

Kesha differs in two ways that shape the design. It has two artifacts with very different
build costs (an npm publish is seconds; a four-platform Rust build with CoreML is not), and
its distribution layer is npm, which already has dist-tags — so property 4 needs no new
mechanism.

Existing machinery that already does part of the job:

- `.github/workflows/npm-publish.yml:105-119` routes any version containing `-` to the
  `beta` dist-tag, so prereleases already cannot reach `latest` users.
- `.github/scripts/check-versions.ts` parses prerelease identifiers and implements SemVer
  precedence, including "a stable version outranks its prereleases".
- `.github/workflows/build-engine.yml:409-411` already distinguishes prerelease tags from
  stable ones and matches `v*` excluding `*-cli`.
- `src/engine-install.ts:200` and `:439` build the asset URL as
  `releases/download/v${engineVersion}/…`, so an alpha Engine tag resolves with no code
  change, provided the tag matches `package.json#keshaEngine.version`
  (`src/package-info.ts:5-6`).

## Goals / Non-Goals

**Goals:**

- An opt-in alpha channel that never perturbs stable consumers.
- CLI alphas continuously, with no human step between merge and installable artifact.
- Engine alphas on demand, immediately consumable without an un-drafting step.
- One publish path shared by both channels, so alphas rehearse the real mechanism.
- Version derivation that is tested before it is trusted.

**Non-Goals:**

- Changing how stable releases are cut.
- Auto-promoting an alpha to stable.
- Reworking the `beta` dist-tag or introducing a beta workflow.
- An in-CLI updater or update check.
- Publishing from a workstation.

## Decisions

### Semantic versioning with a derived sequence, not calendar versioning

Tolaria uses calendar versions (`2026.8.3-alpha.18`). That works for an app distributed by
its own updater, but the CLI is an npm package whose consumers express ranges in SemVer, and
whose stable line is already `1.x.y`. Switching to calendar versions would be a breaking
change to how the package is consumed, for no benefit here.

Alpha versions are therefore `<next-version>-alpha.<N>`, where `<N>` is one more than the
highest existing alpha sequence for that base. SemVer compares numeric prerelease
identifiers numerically, so `1.26.0-alpha.10` correctly sorts above `1.26.0-alpha.2`, and
`1.26.0` above both.

*Alternative considered:* using the workflow run number as the sequence. Rejected — it is
monotonic but not contiguous, it resets if the workflow is recreated, and it carries no
meaning when read in a release list.

### `main` carries the next unreleased version

Calendar versioning let Tolaria dodge the question "what version is this an alpha of".
SemVer does not. Rather than infer the next version from commit messages, `package.json#version`
becomes the next unreleased version immediately after each stable release: after 1.25.0
ships, `main` reads `1.26.0`, and alphas are `1.26.0-alpha.N`.

This makes the base explicit and reviewable in a diff, and makes the stable release a
suffix-drop rather than a guess.

*Alternative considered:* deriving the next version from conventional-commit types since the
last tag. Rejected for now — it adds a second inference layer that can disagree with the
maintainer's intent, and the base can always be corrected by editing one field.

The alpha version is written into `package.json` **in the runner** at publish time and never
committed, exactly as Tolaria injects its computed version into the build.

### npm dist-tags are the channel mechanism

No `alpha-latest.json` analogue is needed. `bun add -g @drakulavich/kesha-voice-kit@alpha`
is the channel selector, and npm already refuses to move `latest` when publishing under
another tag. The existing resolver at `npm-publish.yml:105-119` gains a third branch:
`-alpha.` → `alpha`, other prereleases → `beta`, stable → `latest`.

### CLI alphas continuous, Engine alphas on demand

This is the deliberate divergence from Tolaria's uniform cadence. An npm publish is cheap
enough to run per merge; a four-platform Rust build including the CoreML/Swift link is not,
and the Engine changes far less often. Engine alphas are dispatched manually and publish as
non-draft Prereleases, changing `build-engine.yml:484` from an unconditional `draft: true`
to a draft only for stable tags.

### Extracting the publish path is prerequisite work, not a follow-up

If the alpha workflow publishes by its own copied steps, alphas stop being a rehearsal of
the release and become a parallel implementation that can drift. The publish steps
(`npm-publish.yml:60-119`: version guard, prior-publish check, dist-tag resolution, publish
with provenance) move into a reusable workflow first, with no behaviour change, and both
channels call it.

This ordering also means the risky refactor lands in its own reviewable change, separate
from the new capability.

## Risks / Trade-offs

- **An Engine alpha Prerelease fires `release: published`, which reaches the CLI publish
  workflow.** Its version guard compares `package.json#version` against the tag and would
  fail on every Engine alpha, turning a routine action red. → The publish workflow must
  recognise an Engine-only tag and exit successfully without publishing, rather than failing
  the version comparison.

- **Alpha Engine tags could leak into lanes that download the published Engine**, breaking
  unrelated pull requests. → Those lanes resolve the stable channel explicitly. The existing
  `release/*` guard (`ci.yml:387`, `:448`, `:501`) is the precedent for scoping such lanes.

- **Tag-name exhaustion is permanent.** At Tolaria's cadence the repository accumulates tags
  fast, and GitHub never frees a name. → Sequence numbers make collisions impossible by
  construction; pruning removes Releases and assets but never reissues an identifier.

- **A continuously publishing pipeline is a continuously available supply-chain target.**
  Every alpha publish holds `id-token: write` for provenance. → The existing hardening rule
  applies unchanged: workflow expressions reach `run:` blocks only through `env:`, never by
  direct interpolation.

- **Alphas make it easy to ship the un-reviewed.** A merged-but-unreleased state stops being
  a natural pause. → Alphas are opt-in and unversioned in documentation; nothing in the CLI
  or docs points a first-time reader at the alpha channel.

- **Publishing on every merge multiplies npm versions.** Unpublishing on npm is restricted,
  so the alpha version list grows permanently. → Accepted: it is the cost of the property we
  want, and the `alpha` dist-tag keeps the list out of the default resolution path.

## Migration Plan

1. Land the publish-path extraction with no behaviour change; verify by cutting the next
   stable release through the reusable workflow.
2. Set `package.json#version` to the next unreleased version once that release is out.
3. Land the version-derivation script with its tests, exercised in CI but not yet wired to a
   publish.
4. Enable the alpha workflow on the default branch.
5. Change Engine alpha publishing to non-draft Prerelease and dispatch one by hand.

Rollback: disabling the alpha workflow stops alpha production immediately and affects no
stable artifact. The `alpha` dist-tag can be left in place pointing at the last alpha, or
removed; neither affects `latest`.

## Open Questions

- Retention window for alpha Releases. Days are the right unit at this cadence, but the
  value depends on how far back anyone needs to reach.
- Whether a CLI alpha may name an Engine alpha, or must always resolve a stable Engine.
  Allowing it lets an Engine change be exercised through a CLI alpha; forbidding it keeps
  the channels independent.
- Whether `openspec/specs/GLOSSARY.md` should gain **channel**, **alpha**, and **Prerelease**
  entries as part of this change or separately.
- Whether the alpha workflow's path filter should include `rust/` — a merge touching only
  Engine sources produces a CLI alpha that is byte-identical to its predecessor.
