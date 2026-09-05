## ADDED Requirements

### Requirement: The CLI's Engine is resolved at publish time, never committed

A published CLI SHALL name the Engine it resolves, and that name SHALL be derived when the CLI is published rather than stored in the default branch: a stable CLI resolves the Engine of its own version, a beta resolves the Engine beta of its own version, and an alpha resolves the newest stable Engine unless the person dispatching it names an Engine Prerelease.

#### Scenario: A CLI alpha after a docs-only Engine period

- GIVEN the newest stable Engine is `v2.1.0` and no Engine change has merged since
- WHEN a qualifying merge publishes CLI `2.2.0-alpha.3`
- THEN that alpha resolves Engine `v2.1.0`
- AND no Engine build ran for it

#### Scenario: The default branch carries a pin

- GIVEN a pull request adds an Engine pin field to `package.json`
- WHEN `check:versions` runs
- THEN it fails naming the field and this requirement

> *Technical Note — Replaces `package.json#keshaEngine.version` and rule 3 at `.github/scripts/check-versions.ts:82-91`; injection at publish reuses the alpha version injection in `npm-publish.yml:104-106`.*

## MODIFIED Requirements

### Requirement: A tag names exactly one artifact and one channel

Every release tag SHALL name one version of both artifacts and one Channel by its shape alone: `vX.Y.Z` is stable, `vX.Y.Z-alpha.N` is alpha, `vX.Y.Z-beta.N` is beta, and no other shape SHALL start any release work. A pipeline SHALL decide what to do with a tag without inspecting the commit it points at.

#### Scenario: A stable tag publishes both artifacts

- GIVEN Maks pushes `v2.0.0`
- WHEN the release workflow classifies it
- THEN it builds the Engine, verifies the assets, and publishes the CLI at `2.0.0` resolving Engine `v2.0.0`

#### Scenario: A legacy marker tag is refused

- GIVEN a tag `v2.0.1-cli` is pushed
- WHEN the release workflow classifies it
- THEN it fails before building, naming the accepted shapes

> *Technical Note — Grammar today at `.github/scripts/release-tags.mjs:11-39`; the `-cli` arm is deleted.*

### Requirement: CLI alphas publish on every merge that changes the CLI

Every push to the default branch that changes CLI sources SHALL produce a published CLI alpha without further human action, resolving its Engine as the previous requirement states; a merge that changes nothing a user could run SHALL NOT produce an alpha. Publishing SHALL remain a pipeline action performed with provenance, never from a workstation.

#### Scenario: A merge to the default branch produces an alpha

- GIVEN a pull request changing CLI sources merges to the default branch
- WHEN the release workflow's alpha jobs run
- THEN a CLI alpha is published on the alpha Channel resolving the newest stable Engine
- AND its release notes list the commits since the previous alpha

#### Scenario: A docs-only merge publishes nothing

- GIVEN a pull request that changes only documentation merges
- WHEN the alpha jobs evaluate the change
- THEN no alpha is published
- AND the run records that it deliberately skipped

> *Technical Note — `derive-alpha-version.ts` and `alpha-publishable.ts` move under `release.yml`; behaviour is unchanged except the Engine resolution.*

### Requirement: Alpha and stable publish through one path

The steps that publish a build SHALL exist once, as jobs of one release workflow invoked by every Channel, and every downstream publication (npm, Homebrew tap, Linux packages, container image, Nix version) SHALL run as a job that depends on the job that built and verified the assets, never as a reaction to a GitHub release event. A Channel SHALL differ from another only in the inputs it supplies.

#### Scenario: A change to the publish path is rehearsed

- GIVEN the shared publish jobs are modified
- WHEN the next alpha publishes
- THEN that alpha exercised the modified jobs
- AND a subsequent stable release runs the same jobs

#### Scenario: A release created by the workflow reaches npm

- GIVEN the release workflow created the GitHub release with its own token
- WHEN the npm job runs
- THEN it runs because it depends on the release job, not because an event fired
- AND the package on npm resolves the Engine that release carries

#### Scenario: A downstream job never runs past a failed upstream

- GIVEN the smoke job failed for one platform
- WHEN the npm, tap and packages jobs are evaluated
- THEN none of them runs
- AND the run names the failed upstream job

> *Technical Note — Today npm, tap and post-release listen to `release: published` (`npm-publish.yml:18-20`, `homebrew-tap.yml:3-5`, `post-engine-release.yml:3-5`) and `dispatch-npm-publish.sh:15` works around the missing event; `release.yml` replaces all three with `needs:`.*
