## MODIFIED Requirements

### Requirement: Every shipped platform is verified end to end before release

The release pipeline SHALL verify, for each platform whose Engine is published on the stable Channel, that the built asset performs real synthesis and real Transcription before the release is created — by downloading the just-built asset as a workflow artifact, running `describe`, `kesha say` and a transcription of the result — and SHALL refuse to create the release when any platform fails. A platform whose Engine ships without that verification SHALL be documented as unverified. Because the install-time ASR warm-up is non-fatal by design, a successful `kesha install` SHALL NOT by itself count as verification. Engine assets on the alpha Channel SHALL NOT be presented as verified and SHALL NOT change the platform support matrix.

#### Scenario: Smoke on the built asset

- GIVEN the release workflow built the Engine for a platform
- WHEN the smoke job runs on that platform
- THEN it runs `describe`, synthesises through `kesha say`, transcribes the result back
- AND only then does the release job create the GitHub release

#### Scenario: One platform fails the smoke

- GIVEN the linux-x64 asset cannot synthesise
- WHEN the smoke job reports it
- THEN no GitHub release is created and nothing is published
- AND the run names the failing platform

#### Scenario: Engine builds but cannot synthesise

- GIVEN a platform's Engine compiles and its unit tests pass
- AND its synthesis smoke fails
- WHEN Ira consults the platform matrix
- THEN that platform is not presented as supported

#### Scenario: An alpha Engine does not change the support matrix

- GIVEN an Engine alpha is published for a platform
- WHEN Ira consults the platform matrix
- THEN the matrix reflects the stable Channel only
- AND the alpha is not counted as evidence that the platform is supported

#### Scenario: Alpha Engine assets do not gate stable lanes

- GIVEN an Engine alpha has been published more recently than the newest stable Engine
- WHEN a lane that downloads the published Engine runs on an unrelated pull request
- THEN it resolves the stable Engine
- AND the alpha does not affect that lane's outcome

> *Technical Note — Replaces the post-publication `published-engine-smoke` lane (`ci.yml:518`) and `release-install-smoke.yml`; the smoke script is `.github/scripts/smoke-synthesis.ts`, invoked on artifacts instead of on a downloaded release. Two baseline scenarios are deliberately not carried over, because the verification moves ahead of publication: "Smoke on the published asset" asserted a cold `kesha install` of a published asset and the `!startsWith(github.head_ref, 'release/')` guard that made it skippable on a release branch, and "Warm-up fails but install reports success" asserted a lane reading that install's warm-up log (`.github/scripts/assert-install-warmup.ts`). The `smoke` job runs `describe`, `say` and a transcription on the just-built artifact and never installs, so neither premise exists; the guarantee that a successful install is not by itself verification stays in this requirement's first paragraph.*

### Requirement: Linux packages ship only from a release that publishes the same CLI version

A `.deb` or `.rpm` SHALL be published only by the stable release whose version it carries, and that release SHALL publish the same version to npm in the same run; a run that attaches the packages without publishing that version SHALL fail rather than ship a package naming a CLI version Ira cannot otherwise install. The packaged version is `package.json#version` at the tag, so the release SHALL refuse a tag whose version differs from it. Prerelease tags SHALL ship no packages.

#### Scenario: Maks installs the CLI from apt

- GIVEN a stable tag `vX.Y.Z` is pushed
- WHEN the release workflow runs
- THEN it attaches the `.deb`, the `.rpm` and their `SHA256SUMS` to that release
- AND it publishes `X.Y.Z` to npm in the same run
- AND `X.Y.Z` is the version `package.json` carries at that tag

#### Scenario: The tag names a version the commit does not carry

- GIVEN a tag whose version differs from `package.json#version` at that tag
- WHEN the release workflow classifies it
- THEN it fails before building, naming both versions
- AND no package and no GitHub release is produced

#### Scenario: A Prerelease tag is pushed

- GIVEN a tag on the beta or alpha Channel
- WHEN the release workflow runs
- THEN the packages job is skipped and says why

> *Technical Note — `linux-packages.yml:43` keys on the `-cli` marker today; the `packages` job of `release.yml` keys on the stable Channel through `if: needs.classify.outputs.channel == 'stable'`, and `requireNpmPublishAfterPackaging` in `.github/scripts/check-workflows.ts` keeps the npm job downstream of packaging. The baseline scenario "An engine release is cut" is deliberately not carried over: it asserted that a bare engine tag with no `-cli` marker attaches no Linux package, and under one version there is no engine-only release — every stable tag publishes both artifacts and therefore ships the packages.*
