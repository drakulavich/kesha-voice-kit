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

The alpha version is written into `package.json` **in the runner** and never committed,
exactly as Tolaria injects its computed version into the build. Which runner matters — see
"The publish workflow owns version injection".

### The tag, not the npm registry, is the record of what was published

Deriving from tags only works if each alpha leaves one. Publishing to npm alone would mean
the next merge re-derives the same sequence, the prior-publish check skips it as already
published, and release notes lose their commit boundary — a silent no-op rather than a
failure. Tolaria avoids this implicitly because each of its alphas creates a GitHub Release,
which creates the tag.

So every alpha leaves a tag at the commit it was built from — created *before* the publish,
for the reason set out under "The tag is reserved before the artifact is published". This is
also what makes "a published version identifier is never reissued" enforceable: the tag
outlives the Release, so pruning old alpha Releases cannot free an identifier.

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

### Tag grammar: `-cli` suffix for CLI, bare prerelease for the Engine

`build-engine.yml:3-13` triggers on `v*` excluding `!v*-cli`, so a bare `v<base>-alpha.N`
CLI tag would start the three-platform Engine build — and then fail its dispatch validator
(`:56`) and the release manifest (`release-manifest.mjs:8`), both of which accept only
`vX.Y.Z` or `-beta.N`.

CLI alphas therefore extend the existing marker convention: `v1.26.0-alpha.1-cli`. The
Engine trigger already excludes it, and `npm-publish.yml:80-81` already strips a `-cli`
suffix when deriving the expected version. Engine alphas take the bare form
`v1.24.8-alpha.1`, which needs the two `-beta.N` validators widened to accept `-alpha.N`.

*Alternatives considered:* a `cli-` prefix isolates CLI tags from `v*` completely but breaks
the existing `v1.25.0-cli` convention; leaving both artifacts on identical bare grammar
makes a CLI tag and an Engine tag indistinguishable by shape, which is what causes the
problem in the first place.

### The publish workflow owns version injection

Writing the derived version into `package.json` in the alpha workflow and then calling a
reusable workflow does not work: a `workflow_call` job runs on its own runner and cannot see
the caller's filesystem. The called workflow checks out a ref and validates
`package.json#version` against the tag — and a ref on `main` carries the base version, not
the injected alpha.

So the reusable publish workflow takes the version as an input and applies it after its own
checkout, and its version guard compares against that input rather than assuming the
checkout already matches. `keshaEngine.version` must be correct in the same tarball.

### The tag is reserved before the artifact is published

Publishing first and tagging after leaves a window where npm has a version that no tag
records. The next derivation then reuses that version for a different commit, and the
prior-publish check turns the second publish into a silent skip rather than an error.

The tag is therefore created at the source commit *before* the publish, and functions as the
reservation. Failing to publish after a successful tag wastes an identifier, which is cheap;
publishing without a tag corrupts the sequence, which is not.

### `main`'s base must lead the Engine version

`check-versions.ts:104` requires `package.json#version >= package.json#keshaEngine.version`,
and a prerelease sorts *below* its own stable version. If the CLI base ever equals the
current Engine version, every alpha of that base fails the gate: `1.25.0-alpha.1 < 1.25.0`.

The convention that `main` carries the *next* CLI version keeps the base strictly ahead of
the released Engine, which satisfies the rule — but this is a constraint on when the base is
bumped, not an accident, and the derivation should fail loudly rather than emit a version
that cannot pass the gate.

### Privilege split across jobs

The pipeline needs `contents: write` to create tags and `id-token: write` for npm
provenance. Holding both in one continuously-running job means any merged change to a
workflow, script, or lifecycle hook has a standing path to provenance-backed publication.

The work is split: an unprivileged job checks out, classifies paths, derives and tests; a tag
job holds `contents: write` and no OIDC; the publish job holds `id-token: write` and no tag
write. New workflows pin actions by SHA, as the existing ones do.

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

- **A plain concurrency group drops merges.** GitHub keeps one pending run per group and
  cancels an existing pending run when a newer one joins, so under three quick merges the
  middle one disappears — which contradicts "every qualifying merge produces an alpha". →
  Request queueing explicitly with `queue: max` (up to 100 pending); it cannot be combined
  with `cancel-in-progress`.

- **Derivation can see an incomplete tag set.** A shallow checkout without tags makes every
  run derive sequence 1. → The derivation job fetches full history and tags, as
  `build-engine.yml:44-45` already does for the same reason.

- **A CLI alpha produces an npm version and a Git tag, but no GitHub Release**, while the
  retention requirement talks about pruning alpha Releases. → Retention applies to Engine
  alpha Releases and to any Release the CLI alpha workflow chooses to create; the npm version
  and the tag are permanent either way. If CLI alphas do get Releases, publishing one fires
  `release: published` and reaches the publish workflow, which must recognise its own tag and
  decline rather than republish.

- **Publishing on every merge multiplies npm versions.** Unpublishing on npm is restricted,
  so the alpha version list grows permanently. → Accepted: it is the cost of the property we
  want, and the `alpha` dist-tag keeps the list out of the default resolution path.

## Migration Plan

1. Set `package.json#version` to the next unreleased version once the current release is
   out. The derivation is invalid until the base leads the Engine version, so this comes
   first, not last.
2. Fix the tag grammar and widen the Engine-side validators, so no later step can push a tag
   that starts an unwanted build.
3. Land the publish-path extraction with no behaviour change; verify by cutting the next
   stable release through the reusable workflow.
4. Land the version-derivation script with its tests, exercised but not yet wired to a
   publish.
5. Enable the alpha workflow on the default branch.
6. Change Engine alpha publishing to non-draft Prerelease and dispatch one by hand.

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
