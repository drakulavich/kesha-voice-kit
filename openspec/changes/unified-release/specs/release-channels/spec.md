## ADDED Requirements

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

> *Technical Note — Replaces `package.json#keshaEngine.version` (read at `src/package-info.ts:5-6`, turned into an asset URL at `src/engine-install.ts:187` and `:447`) and rule 3 at `.github/scripts/check-versions.ts:82-91`; injection at publish reuses the alpha version injection in `npm-publish.yml:104-106`.*

## MODIFIED Requirements

### Requirement: A tag names exactly one artifact and one channel

Every release tag SHALL name one version of both artifacts and one Channel by its shape alone: `vX.Y.Z` is stable, `vX.Y.Z-alpha.N` is alpha, `vX.Y.Z-beta.N` is beta, and no other shape SHALL start any release work. A pipeline SHALL decide what to do with a tag without inspecting the commit it points at.

An alpha tag SHALL be a record rather than a trigger: the alpha jobs write it after they publish, and pushing it SHALL start no run, so a published alpha version can never be published twice.

#### Scenario: A stable tag publishes both artifacts

- GIVEN Maks pushes `v2.0.0`
- WHEN the release workflow classifies it
- THEN it builds the Engine, verifies the assets, and publishes the CLI at `2.0.0` resolving Engine `v2.0.0`

#### Scenario: A legacy marker tag is refused

- GIVEN a tag `v2.0.1-cli` is pushed
- WHEN the release workflow classifies it
- THEN it fails before building, naming the accepted shapes

#### Scenario: A recorded alpha tag starts nothing

- GIVEN the alpha jobs record `v2.2.0-alpha.3` after publishing it
- WHEN that tag reaches the remote
- THEN no release run starts from it
- AND the published `2.2.0-alpha.3` is not republished

> *Technical Note — Grammar today at `.github/scripts/release-tags.mjs:11-39`; the `-cli` arm is deleted. The tag trigger filter excludes `v*-alpha.*` so a recorded tag cannot re-enter the workflow. Three baseline scenarios are deliberately not carried over, because each asserts a two-artifact world this change ends: "A CLI alpha tag does not trigger an Engine build" and "An Engine alpha tag passes Engine validators" both describe a tag reaching a separate Engine build workflow, which no longer exists — alpha tags are records that start no run at all, which "A recorded alpha tag starts nothing" asserts more strongly; "A tag belonging to another artifact is rejected" has no other artifact to reject, and "A legacy marker tag is refused" is what it becomes.*

### Requirement: CLI alphas publish on every merge that changes the CLI

Every push to the default branch that changes CLI sources SHALL produce a published CLI alpha without further human action, resolving its Engine as the previous requirement states and building no Engine; a merge that changes nothing Ira could run SHALL NOT produce an alpha. Publishing SHALL remain a pipeline action performed with provenance, never from a workstation.

#### Scenario: A merge to the default branch produces an alpha

- GIVEN a pull request changing CLI sources merges to the default branch
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

> *Technical Note — `derive-alpha-version.ts` and `alpha-publishable.ts` move under `release.yml`; behaviour is unchanged except the Engine resolution and the `if: needs.classify.outputs.path != 'cli-alpha'` guard that skips `build-engine`, `smoke` and `github-release` (`packages`, `homebrew`, `docker` and `nix-version` are guarded on the stable Channel instead, so a beta does not ship them either). Ordering across concurrent merges is a queue, not a cancelling concurrency group: GitHub cancels a pending run when a newer one joins the group, which would drop the middle merge, and the skip decision is made inside a job because a workflow-level path filter leaves no run to report from. The queue is `release.yml`'s `concurrency` group with `queue: max` (today `.github/workflows/npm-publish.yml:37-39`); `ci.yml`'s `cancel-in-progress: true` (`ci.yml:28-30`) never applies to the release workflow.*

### Requirement: Engine alphas are published deliberately, not per merge

An Engine alpha SHALL be published only when a person dispatches one, and that dispatch SHALL publish the CLI at the same version in the same run, so neither artifact is consumable without the other. Engine alphas SHALL be Prereleases and SHALL be immediately consumable — an Engine alpha that requires a manual un-drafting step before it can be installed does not satisfy this requirement.

A per-merge CLI alpha SHALL NOT build or publish an Engine; it resolves the newest stable Engine instead.

An Engine alpha SHALL be resolvable by the CLI through the same mechanism that resolves a stable Engine, so that installing an alpha exercises the real download path.

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

> *Technical Note — The baseline scenario "Publishing an Engine alpha does not publish a CLI" is deliberately not carried over: under one version a dispatched alpha publishes both artifacts in the same run by design, which is what "A dispatched alpha publishes both artifacts at one version" asserts instead. `.github/workflows/build-engine.yml:547-562` publishes every build as a draft and then un-drafts alphas by hand today; `release.yml`'s `github-release` job publishes a Prerelease directly for both pre-release Channels. `src/engine-install.ts:187` and `:447` build the asset URL as `releases/download/v${engineVersion}/…`, and under one version that name is injected at publish rather than read from `package.json#keshaEngine.version` (`src/package-info.ts:5-6`).*

### Requirement: Alpha and stable publish through one path

The steps that publish a build SHALL exist once, as jobs of one release workflow invoked by every Channel, and every downstream publication (npm, Homebrew tap, Linux packages, container image, Nix version) SHALL run as a job that depends on the job that built and verified the assets, never as a reaction to a GitHub release event. A Channel SHALL differ from another only in the inputs it supplies.

A release SHALL be published in the run that built and smoked its assets, never left as a draft for a person to un-draft, because the smoke on the just-built assets is the verification a draft used to stand in for. Stable is published as Latest; beta and a dispatched alpha are published as Prereleases.

This is the property that makes an alpha meaningful as a rehearsal: a change to the publish path SHALL be exercised by alphas before a stable release depends on it.

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

> *Technical Note — Today npm, tap and post-release listen to `release: published` (`npm-publish.yml:18-20`, `homebrew-tap.yml:3-5`, `post-engine-release.yml:3-5`) and `dispatch-npm-publish.sh:15` works around the missing event; `release.yml` replaces all three with `needs: github-release`. The draft-and-un-draft pair at `.github/workflows/build-engine.yml:547-562` disappears with it.*
