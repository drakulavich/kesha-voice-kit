## MODIFIED Requirements

### Requirement: Every shipped platform is verified end to end before release

The release pipeline SHALL verify, for each platform whose Engine is published **on the
stable channel**, that the shipped binary performs real synthesis and real Transcription —
not only that it builds and passes unit tests. A platform whose Engine ships without that
verification SHALL be documented as unverified rather than presented as supported.

Verification SHALL cover both the asset a user downloads today and the artifact a release is
about to publish. These are different binaries reached by different means: a release branch
cannot download its own Engine, because its tag does not exist until the release is un-drafted.

Because the install-time ASR warm-up is non-fatal by design, a successful `kesha install`
SHALL NOT by itself be treated as evidence that the Engine initialises on that platform.

Engine assets published on the alpha channel SHALL NOT be presented as verified. An alpha
Engine carries only the checks that ran before it was published, and the platform support
matrix SHALL continue to reflect the stable channel — publishing an alpha SHALL NOT change
what any platform is claimed to support.

#### Scenario: Smoke on the published asset

- GIVEN release v`<engineVersion>` publishes an Engine asset for a platform
- WHEN the published-asset smoke lane runs on that platform
- THEN it performs a cold `kesha install`, synthesises through `kesha say`, and
  transcribes the result back
- AND the lane does not run on `release/*` branches, whose tag is not yet published

#### Scenario: Warm-up fails but install reports success

- GIVEN the Engine installs and the CLI exits 0
- AND the install log carries an ASR backend warm-up failure
- WHEN the smoke lane inspects that log
- THEN the lane fails rather than reporting the platform verified

#### Scenario: Engine builds but cannot synthesise

- GIVEN a platform's Engine compiles and its unit tests pass
- AND its synthesis smoke fails
- WHEN Ira consults the platform matrix
- THEN that platform is not presented as supported

#### Scenario: An alpha Engine does not change the support matrix

- GIVEN an Engine alpha is published for a platform
- WHEN Ira consults the platform matrix
- THEN the matrix reflects the stable channel only
- AND the alpha is not counted as evidence that the platform is supported

#### Scenario: Alpha Engine assets do not gate stable lanes

- GIVEN an Engine alpha has been published more recently than the newest stable Engine
- WHEN a lane that downloads the published Engine runs on an unrelated pull request
- THEN it resolves the stable Engine
- AND the alpha does not affect that lane's outcome

> *Technical Note — sources: `.github/workflows/ci.yml` (`published-engine-smoke` on
> ubuntu-latest, `windows-engine-smoke` on windows-latest — both run a cold install and
> `.github/scripts/smoke-synthesis.ts`), `.github/scripts/assert-install-warmup.ts`, and
> `rust/src/cli/install.rs` (warm-up warns and continues, #298). The engine-downloading
> lanes carry a `!startsWith(github.head_ref, 'release/')` guard at `ci.yml:387`, `:448`
> and `:501`; the channel those lanes resolve is what keeps alpha Engine tags out of
> unrelated pull requests.*
