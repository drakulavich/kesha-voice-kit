## ADDED Requirements

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

> *Technical Note — sources: `.github/workflows/npm-publish.yml:105-119` resolves the npm
> dist-tag today, collapsing every prerelease onto `beta`; this requirement needs a third
> outcome for `-alpha.` versions. `.github/scripts/check-versions.ts` already implements
> SemVer precedence including "a stable version outranks its prereleases".*

### Requirement: CLI alphas publish on every merge that changes the CLI

Every push to the default branch that changes CLI sources SHALL produce a published CLI
alpha without further human action. A merge that changes nothing a user could run — docs,
unrelated subprojects, workflow files not on the release path — SHALL NOT produce an alpha.

Publishing SHALL remain a pipeline action performed with provenance. No alpha is published
from a workstation.

#### Scenario: A merge to the default branch produces an alpha

- GIVEN a pull request changing CLI sources merges to the default branch
- WHEN the alpha pipeline runs
- THEN a CLI alpha is published on the alpha channel
- AND its release notes list the commits since the previous alpha

#### Scenario: A docs-only merge publishes nothing

- GIVEN a pull request that changes only documentation merges to the default branch
- WHEN the alpha pipeline evaluates the change
- THEN no alpha is published
- AND the pipeline reports that it deliberately skipped, rather than failing

#### Scenario: Two merges land in quick succession

- GIVEN an alpha publish is already in flight
- WHEN a second qualifying merge lands before it finishes
- THEN each merge SHALL end with a distinct published alpha version
- AND no published alpha version is ever reused for different source

> *Technical Note — the existing publish path fires on `release: published`
> (`.github/workflows/npm-publish.yml:9-11`) and is therefore tied to the manual draft
> gate; continuous alphas need a trigger on the default branch instead. Provenance comes
> from `id-token: write` plus `npm publish --provenance` (`npm-publish.yml:22-24`).*

### Requirement: Engine alphas are published deliberately, not per merge

An Engine alpha SHALL be published only when a person asks for one. Engine alphas SHALL be
Prereleases and SHALL be immediately consumable — an Engine alpha that requires a manual
un-drafting step before it can be installed does not satisfy this requirement.

An Engine alpha SHALL be resolvable by the CLI through the same mechanism that resolves a
stable Engine, so that installing an alpha exercises the real download path.

#### Scenario: Maks requests an Engine alpha

- GIVEN a change to Engine sources has merged
- WHEN Maks dispatches an Engine alpha build
- THEN the Engine alpha is published as a Prerelease
- AND `kesha install` against a CLI pinned to that Engine version downloads it without
  any manual release step in between

#### Scenario: A CLI alpha that does not change the Engine

- GIVEN a CLI alpha whose merge changed no Engine sources
- WHEN that alpha is published
- THEN it SHALL resolve the current stable Engine
- AND publishing it SHALL NOT require an Engine build

#### Scenario: Publishing an Engine alpha does not publish a CLI

- GIVEN an Engine alpha Prerelease is published
- WHEN the publish pipelines react to it
- THEN no CLI package is published as a side effect
- AND the pipeline does not report a failure for having declined

> *Technical Note — sources: `src/engine-install.ts:200` and `:439` build the asset URL as
> `releases/download/v${engineVersion}/…`, so an Engine alpha resolves with no code change
> provided its tag matches `package.json#keshaEngine.version` (`src/package-info.ts:5-6`).
> `.github/workflows/build-engine.yml:409-411` already distinguishes prerelease tags, but
> `:484` publishes every build as a draft. Publishing a Prerelease fires
> `release: published`, which today reaches the CLI publish workflow.*

### Requirement: Alpha versions are derived, never hand-written

An alpha version SHALL be computed from the repository's existing tags at publish time. No
commit SHALL be required to record an alpha version, and the default branch SHALL NOT
accumulate version-bump commits for alphas.

Every published alpha SHALL leave a tag behind at the commit it was built from. The tag is
what the next derivation counts, what bounds the next set of release notes, and what makes
a published version identifier permanently taken — an alpha that publishes an artifact
without recording a tag would let the next derivation reuse its version.

Alpha versions SHALL sort in publication order, SHALL sort below the stable version they
lead up to, and SHALL be unique for the lifetime of the repository.

The derivation SHALL be covered by its own tests, run before it is trusted to produce a
version.

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

#### Scenario: The artifact publishes but the tag does not land

- GIVEN an alpha's artifact has been published
- WHEN recording its tag fails
- THEN the pipeline reports failure rather than success
- AND the condition is surfaced, because the next derivation would otherwise reuse that
  version identifier

#### Scenario: Derivation is verified before use

- GIVEN the alpha pipeline is about to compute a version
- WHEN its tests fail
- THEN no alpha is published

#### Scenario: A malformed or unexpected existing tag

- GIVEN the repository contains a tag that does not match the alpha naming scheme
- WHEN the version is derived
- THEN that tag is ignored rather than causing a wrong sequence
- AND the derivation does not fail because of it

> *Technical Note — the base version comes from `package.json#version`, which this change
> makes "the next unreleased version" rather than "the last released one".
> `.github/scripts/check-versions.ts` is the existing drift gate across
> `package.json#version`, `package.json#keshaEngine.version`, and `rust/Cargo.toml`; it
> already parses prerelease identifiers and must keep passing for alpha versions.*

### Requirement: Alpha and stable publish through one path

The steps that publish a build SHALL exist once and be invoked by both channels. A channel
SHALL differ from another only in the inputs it supplies — which version, which channel
label, which artifacts — not in the mechanism it uses.

This is the property that makes an alpha meaningful as a rehearsal: a change to the publish
path SHALL be exercised by alphas before a stable release depends on it.

#### Scenario: A change to the publish path is rehearsed

- GIVEN the shared publish steps are modified
- WHEN the next alpha publishes
- THEN that alpha exercised the modified steps
- AND a subsequent stable release runs the same steps

#### Scenario: A channel cannot silently diverge

- GIVEN a fix is applied to the publish path for one channel
- WHEN the other channel next publishes
- THEN it SHALL use the fixed path rather than an unfixed copy

> *Technical Note — today the publish steps live inline in
> `.github/workflows/npm-publish.yml:60-119` (version guard, prior-publish check, dist-tag
> resolution, publish with provenance) with no reusable entry point.*

### Requirement: The release list stays readable at alpha cadence

Alpha Releases SHALL be pruned on a stated age policy so that the release list remains
usable for finding stable releases. Pruning SHALL NOT remove any stable release, and SHALL
NOT free an alpha tag name for reuse — a published version identifier is never reissued for
different source.

#### Scenario: Old alphas are pruned

- GIVEN alpha Releases older than the retention window exist
- WHEN the pruning policy runs
- THEN those alpha Releases are removed
- AND every stable release remains

#### Scenario: A pruned version is never reissued

- GIVEN an alpha Release has been pruned
- WHEN the next alpha version is derived
- THEN it SHALL NOT reuse the pruned version identifier

> *Technical Note — GitHub reserves tag names permanently, which the release runbook already
> treats as an invariant ("Tag names are one-use"); pruning therefore applies to Releases and
> assets, and the derivation must not depend on a pruned Release still existing.*

## Open Issues

- `openspec/specs/GLOSSARY.md` has no entry for **channel**, **alpha**, or **Prerelease**.
  These terms are used throughout this spec and should be added to the glossary rather than
  defined ad hoc here. Not resolved in this change's specs because the delta format covers
  requirements, not the glossary.
- The retention window for alpha Releases is stated as a policy but not given a number.
  Tolaria's cadence (18 alphas in one day) suggests days rather than releases as the unit,
  but the right value depends on how far back Maks ever needs to reach.
- Whether a CLI alpha should be able to name an Engine alpha at all, or whether alpha CLIs
  must always resolve a stable Engine, is unresolved. Allowing it makes the two channels
  interact; forbidding it means an Engine change cannot be exercised through a CLI alpha.
- Lanes that download the published Engine carry a `release/*` branch guard
  (`.github/workflows/ci.yml:387`, `:448`, `:501`). Whether alpha Engine tags need an
  analogous guard, or whether pinning those lanes to the stable channel is sufficient, is
  not settled.
