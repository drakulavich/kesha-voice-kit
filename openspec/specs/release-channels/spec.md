# Release Channels Specification

## Purpose

Release channels govern how a build reaches a user: which channels exist, what each
promises about stability, how a channel is selected at install time, how alpha versions
are derived and ordered, and which guarantees hold on alpha versus stable. The project
publishes on two channels — **stable**, resolved when no channel is named, and **alpha**,
an opt-in Prerelease channel that exercises the release path continuously without changing
what an unqualified install resolves.

## Requirements

### Requirement: A tag names exactly one artifact and one channel

Every release tag SHALL name one version of both artifacts and one Channel by its shape alone: `vX.Y.Z` is stable, `vX.Y.Z-alpha.N` is alpha, `vX.Y.Z-beta.N` is beta, and no other shape SHALL start any release work. A pipeline SHALL decide what to do with a tag without inspecting the commit it points at.

An alpha tag SHALL be written by the alpha jobs when they reserve its version, before publishing, and pushing it SHALL start no run.

#### Scenario: A stable tag publishes both artifacts

- GIVEN Maks pushes `v2.0.0`
- WHEN the release workflow classifies it
- THEN it builds the Engine, verifies the assets, and publishes the CLI at `2.0.0` resolving Engine `v2.0.0`

#### Scenario: A legacy marker tag is refused

- GIVEN a tag `v2.0.1-cli` is pushed
- WHEN the release workflow classifies it
- THEN it fails before building, naming the accepted shapes

#### Scenario: A recorded alpha tag starts nothing

- GIVEN the alpha jobs record `v2.2.0-alpha.3` while publishing it
- WHEN that tag reaches the remote
- THEN no release run starts from it
- AND the published `2.2.0-alpha.3` is not republished

> *Technical Note — sources: `.github/scripts/release-classify.ts::classifyRelease`, run by `.github/workflows/release.yml::classify`, whose tag trigger excludes `v*-alpha.*` so a recorded tag cannot re-enter the workflow. An alpha tag is a record, never a trigger: writing it before publishing means a failed publish leaves a gap in the sequence instead of a version the next derivation reuses, and starting no run means a published alpha version can never be published twice. Three earlier scenarios were retired with the two-artifact world: "A CLI alpha tag does not trigger an Engine build" and "An Engine alpha tag passes Engine validators" described a tag reaching a separate Engine build workflow, which no longer exists, and "A tag belonging to another artifact is rejected" has no other artifact to reject; "A recorded alpha tag starts nothing" and "A legacy marker tag is refused" replace them.*

### Requirement: Alpha builds reach only people who ask for them

The project SHALL publish on two channels: **stable**, which is what an install command
resolves when no channel is named, and **alpha**, which is reached only by naming it.
Publishing an alpha SHALL NOT change what an unqualified install resolves, and SHALL NOT
alter any existing stable artifact.

Alpha builds carry no stability promise. They exist so Maks can run a change on his own
machine before it is blessed, and so the release path is exercised continuously rather
than once per release.

#### Scenario: Maks opts into the alpha channel

- GIVEN an alpha of the CLI has been published
- WHEN Maks installs the CLI naming the alpha channel
- THEN he receives the alpha build
- AND the version he receives identifies itself as a prerelease

#### Scenario: An alpha publish leaves the default channel untouched

- GIVEN Ira's pipeline installs the CLI without naming a channel
- WHEN an alpha is published
- THEN Ira's pipeline continues to resolve the newest stable version
- AND re-running the same pipeline before and after the alpha publish yields the same version

#### Scenario: A stable release outranks its own alphas

- GIVEN alphas exist for a version that has not shipped yet
- WHEN that version is released on the stable channel
- THEN the stable version SHALL be ordered above every alpha carrying the same base version

> *Technical Note — sources: `.github/scripts/release-classify.ts::classifyRelease` maps the
> Channel to the dist-tag (`DIST_TAG`), so an alpha resolves to `alpha` rather than
> collapsing onto `beta`, and `release.yml`'s `npm-publish` job publishes under it.
> `src/semver.mjs::cmp` implements SemVer precedence, including "a stable version outranks
> its prereleases".*

### Requirement: CLI alphas publish on every merge that changes the CLI

Every push to the default branch that changes packed CLI sources and whose pull request carries the `alpha` label SHALL produce a published CLI alpha without further human action, resolving its Engine as the previous requirement states and building no Engine; a merge that changes nothing Ira could run SHALL NOT produce an alpha. Publishing SHALL remain a pipeline action performed with provenance, never from a workstation.

#### Scenario: A merge to the default branch produces an alpha

- GIVEN a pull request changing CLI sources and labelled `alpha` merges to the default branch
- WHEN the release workflow's alpha jobs run
- THEN a CLI alpha is published on the alpha Channel resolving the newest stable Engine
- AND its release notes list the commits since the previous alpha
- AND the Engine-building jobs were skipped

#### Scenario: A docs-only merge publishes nothing

- GIVEN a pull request that changes only documentation merges
- WHEN the alpha jobs evaluate the change
- THEN no alpha is published
- AND the run records that it deliberately skipped, in a form a person can read
  afterwards without inferring it from an absent run

#### Scenario: Three merges land in quick succession

- GIVEN an alpha publish is already in flight
- WHEN two further qualifying merges land before it finishes
- THEN each of the three merges SHALL end with its own published alpha version
- AND no qualifying merge is silently dropped because a later one superseded it
- AND no published alpha version is ever reused for different source

> *Technical Note — sources: `.github/scripts/release-plan.ts::planRelease` and `.github/scripts/release-plan.ts::deriveReleaseAlpha`, run by `.github/workflows/release.yml::plan` after the packed-path check (`.github/scripts/alpha-publishable.ts`) and the `alpha` label gate (`.github/scripts/alpha-requested.sh`); `.github/workflows/release.yml::reserve-tag` records the tag before `npm-publish`. Ordering across concurrent merges is `release.yml`'s `concurrency` group with `queue: max`, pinned by `.github/scripts/check-workflows.ts::requireReleaseQueue`: a cancelling group would drop the middle of three quick merges, and the skip decision is made inside a job because a workflow-level path filter leaves no run to report from.*

### Requirement: Engine alphas are published deliberately, not per merge

An Engine alpha SHALL be published only when a person dispatches one, and that dispatch SHALL publish the CLI at the same version in the same run. Engine alphas SHALL be Prereleases, installable with no manual un-drafting step.

A per-merge CLI alpha SHALL NOT build or publish an Engine; it resolves the newest stable Engine instead.

The CLI SHALL resolve an Engine alpha through the same mechanism that resolves a stable Engine.

#### Scenario: Maks requests an Engine alpha

- GIVEN a change to Engine sources has merged
- WHEN Maks dispatches an alpha build
- THEN the Engine alpha is published as a Prerelease in that same run
- AND `kesha install` against the CLI of that alpha version downloads it without any manual release step in between

#### Scenario: A CLI alpha that does not change the Engine

- GIVEN a per-merge CLI alpha whose merge changed no Engine sources
- WHEN that alpha is published
- THEN it SHALL resolve the current stable Engine
- AND publishing it SHALL NOT require an Engine build

#### Scenario: A dispatched alpha publishes both artifacts at one version

- GIVEN Maks dispatches an alpha at `2.3.0-alpha.1`
- WHEN the release workflow runs
- THEN the GitHub Prerelease carries the Engine assets for that version
- AND npm carries `2.3.0-alpha.1` on the alpha Channel resolving that Engine
- AND neither artifact is published without the other

> *Technical Note — sources: `.github/scripts/release-classify.ts::fromDispatch` (an alpha builds the Engine unless it names `engine-prerelease`), `.github/scripts/release-plan.ts::planRelease` (the Engine it resolves), `.github/scripts/engine-pin.ts::buildEnginePin` and `src/engine-install.ts::releaseChecksums` (the injected pin the installer verifies against). Publishing both artifacts in one run means neither is consumable without the other, and resolving an Engine alpha like a stable one means installing an alpha exercises the real download path. The earlier scenario "Publishing an Engine alpha does not publish a CLI" was retired: under one version a dispatched alpha publishes both artifacts in the same run by design.*

### Requirement: Alpha versions are derived, never hand-written

An alpha version SHALL be computed from the repository's existing tags at publish time. No
commit SHALL be required to record it, and the default branch SHALL NOT accumulate
version-bump commits for alphas. Every published alpha SHALL leave a tag at the commit it
was built from.

Alpha versions SHALL sort in publication order and below the stable version they lead up
to, and SHALL be unique for the repository's lifetime. The derivation SHALL pass its own tests
before it is trusted.

#### Scenario: Sequence advances within a base version

- GIVEN alphas already exist for the next unreleased version
- WHEN another alpha is published for that same base version
- THEN its sequence is one higher than the highest existing alpha for that base
- AND it sorts above every earlier alpha for that base

#### Scenario: Consecutive merges each advance the sequence

- GIVEN an alpha has been published for the current base version
- WHEN a further qualifying merge lands and its alpha is derived
- THEN the derivation observes the previous alpha's tag
- AND the new alpha carries the next sequence rather than repeating the published one

#### Scenario: The tag cannot be recorded

- GIVEN an alpha version has been derived
- WHEN recording its tag fails
- THEN nothing is published under that version
- AND the run reports failure rather than success

#### Scenario: The tag lands but the publish fails

- GIVEN an alpha's tag has been recorded
- WHEN publishing the artifact then fails
- THEN that version identifier SHALL NOT be reused by a later alpha
- AND the next alpha takes the following sequence instead

#### Scenario: Derivation is verified before use

- GIVEN the alpha pipeline is about to compute a version
- WHEN its tests fail
- THEN no alpha is published

#### Scenario: A malformed or unexpected existing tag

- GIVEN the repository contains a tag that does not match the alpha naming scheme
- WHEN the version is derived
- THEN that tag is ignored rather than causing a wrong sequence
- AND the derivation does not fail because of it

> *Technical Note — the tag is what the next derivation counts, what bounds the next set of
> release notes, and what makes a published version identifier permanently taken: an alpha
> that publishes an artifact without recording a tag would let the next derivation reuse its
> version. The base version comes from `package.json#version`, which this change
> makes "the next unreleased version" rather than "the last released one".
> `.github/scripts/check-versions.ts` is the existing drift gate across
> `package.json#version`, `server.json` and `rust/Cargo.toml`, and refuses a committed
> `keshaEngine` or `kesha.engine`; it parses prerelease identifiers and keeps passing
> for alpha versions.*

### Requirement: Alpha and stable publish through one path

The steps that publish a build SHALL exist once, as jobs of one release workflow invoked by every Channel, and a Channel SHALL differ from another only in the inputs it supplies. Every downstream publication (npm, Homebrew tap, container image) SHALL run as a job that depends on the job that built and verified the assets, never as a reaction to a GitHub release event. A change to the publish path SHALL be exercised by alphas before a stable release depends on it.

#### Scenario: A change to the publish path is rehearsed

- GIVEN the shared publish jobs are modified
- WHEN the next alpha publishes
- THEN that alpha exercised the modified jobs
- AND a subsequent stable release runs the same jobs

#### Scenario: A channel cannot silently diverge

- GIVEN a fix is applied to the publish path for one Channel
- WHEN the other Channel next publishes
- THEN it SHALL use the fixed path rather than an unfixed copy

#### Scenario: A release created by the workflow reaches npm

- GIVEN the release workflow smoked the built assets and published the GitHub release with its own token
- WHEN the npm job runs
- THEN it runs because it depends on the release job, not because an event fired
- AND the package on npm resolves an Engine that is already published, never a draft

#### Scenario: A downstream job never runs past a failed upstream

- GIVEN the smoke job failed for one platform
- WHEN the npm, tap and packages jobs are evaluated
- THEN none of them runs
- AND the run names the failed upstream job

> *Technical Note — sources: `.github/workflows/release.yml::assemble`, `.github/workflows/release.yml::github-release` (one `.github/scripts/publish-release.sh` call, which drafts, uploads and publishes — the only order immutable releases accept) and `.github/workflows/release.yml::npm-publish`; `.github/scripts/check-workflows.ts::requireReleaseJobOrder` pins the order and keeps every write or OIDC permission off a rehearsal. Nix has no job: `flake.nix` reads `package.json#version` when it builds. One path for every Channel is what makes an alpha meaningful as a rehearsal of the stable release.*

### Requirement: A release publishes every asset in one step

Every asset of a release (Engine binaries, Sidecars, Linux packages, SBOM, manifest) SHALL be built before the release is published and SHALL be published with it in one step, under one `SHA256SUMS`.

#### Scenario: A stable release carries all its assets at once

- GIVEN Maks pushes `v2.0.0` and every platform builds
- WHEN the release workflow publishes the GitHub release
- THEN the release carries the Engine binaries, Sidecars, Linux packages, SBOM and manifest
- AND one `SHA256SUMS` lists every asset

#### Scenario: A failed asset build publishes no release

- GIVEN the Linux packages job failed for `v2.0.0`
- WHEN the release job is evaluated
- THEN no release is published
- AND no asset is uploaded to a release that is already published

> *Technical Note — sources: `.github/workflows/release.yml::assemble` gathers the assets and `.github/workflows/release.yml::github-release` publishes them through one `.github/scripts/publish-release.sh` call. The repository's releases are immutable once published, so an asset added after publication would be refused.*

### Requirement: A release is published in the run that smoked its assets

A release SHALL be published in the run that built and smoked its assets, never left as a draft for a person to un-draft. Stable SHALL be published as Latest; beta and a dispatched alpha SHALL be published as Prereleases.

#### Scenario: A stable release is published as Latest without a draft step

- GIVEN Maks pushes `v2.0.0` and the smoke passes on the just-built assets
- WHEN the release job runs
- THEN the release is published as Latest in that same run
- AND no draft waits for a person to un-draft it

#### Scenario: A beta is published as a Prerelease

- GIVEN Maks pushes `v2.1.0-beta.1`
- WHEN the release job runs
- THEN the release is published as a Prerelease
- AND the Latest release stays the newest stable one

#### Scenario: A failed smoke leaves no release behind

- GIVEN the smoke on the just-built assets failed for one platform
- WHEN the release job is evaluated
- THEN no release is published and no draft is left

> *Technical Note — sources: `.github/scripts/publish-release.sh` passes `--latest` for stable and `--prerelease --latest=false` otherwise; `.github/workflows/release.yml::assemble` requires the smoke jobs to succeed. The smoke on the just-built assets is the verification a draft used to stand in for.*

### Requirement: The release list stays readable at alpha cadence

Alpha Releases SHALL be pruned **30 days from publication** so that the release list remains
usable for finding stable releases. Pruning SHALL NOT remove any stable release, SHALL NOT
remove a draft, and SHALL NOT free an alpha tag name for reuse: a published version
identifier is never reissued for different source.

#### Scenario: Old alphas are pruned

- GIVEN alpha Releases older than the retention window exist
- WHEN the pruning policy runs
- THEN those alpha Releases are removed
- AND every stable release remains

#### Scenario: A pruned version is never reissued

- GIVEN an alpha Release has been pruned
- WHEN the next alpha version is derived
- THEN it SHALL NOT reuse the pruned version identifier

#### Scenario: A draft alpha is never pruned

- GIVEN an alpha Release that failed to publish has stayed a draft for more than 30 days
- WHEN the pruning policy runs
- THEN the draft remains

> *Technical Note — GitHub reserves tag names permanently, which the release runbook already
> treats as an invariant ("Tag names are one-use"); pruning therefore applies to Releases and
> assets, and the derivation must not depend on a pruned Release still existing. A CLI alpha leaves no
> Release to prune, so in practice the window governs Engine alphas. A draft has no
> publication date to age from, and an alpha that failed to publish is still something a
> person may be reading. Sources: `.github/scripts/prune-alpha-releases.ts::prunable`
> (`RETENTION_DAYS`), run by `.github/scripts/prune-alpha-releases.sh` from
> `.github/workflows/nightly.yml`.*

### Requirement: The CLI's Engine is resolved at publish time, never committed

A published CLI SHALL name the Engine it resolves, and that name SHALL be derived when the CLI is published rather than stored in the default branch: a stable CLI resolves the Engine of its own version, a beta resolves the Engine beta of its own version, a per-merge alpha resolves the newest stable Engine and builds none, and a dispatched alpha resolves the Engine built in the same run unless the person dispatching it names an Engine Prerelease.

#### Scenario: A CLI alpha after a docs-only Engine period

- GIVEN the newest stable Engine is `v2.1.0` and no Engine change has merged since
- WHEN a qualifying merge publishes CLI `2.2.0-alpha.3`
- THEN that alpha resolves Engine `v2.1.0`
- AND no Engine build ran for it

#### Scenario: The default branch carries a pin

- GIVEN a pull request adds an Engine pin field to `package.json`
- WHEN `check:versions` runs
- THEN it fails naming the field and this requirement

> *Technical Note — sources: `.github/scripts/engine-pin.ts::withEnginePin` writes `package.json#kesha.engine`; `src/package-info.ts::resolveEngine` reads it; `.github/scripts/check-versions.ts` refuses a committed `keshaEngine` or `kesha.engine`; lanes that download a published Engine install the highest stable one through `.github/scripts/newest-stable-engine.sh`.*

## Open Issues

- Whether a CLI alpha should be able to name an Engine alpha at all, or whether alpha CLIs
  must always resolve a stable Engine, is unresolved. Allowing it makes the two channels
  interact; forbidding it means an Engine change cannot be exercised through a CLI alpha.
- Lanes that download the published Engine
  (`.github/workflows/ci.yml::integration-tests-full`,
  `.github/workflows/ci.yml::published-engine-smoke` and
  `.github/workflows/ci.yml::windows-engine-smoke`) install the newest stable one, so they
  carry no branch or commit-message guard. Whether alpha Engine tags need a guard of their own, or whether
  pinning those lanes to the stable channel is sufficient, is not settled.
