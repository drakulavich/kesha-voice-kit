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

#### Scenario: An alpha Engine does not change the support matrix

- GIVEN an Engine alpha is published for a platform
- WHEN Ira consults the platform matrix
- THEN the matrix reflects the stable Channel only

> *Technical Note — Replaces the post-publication `published-engine-smoke` lane (`ci.yml:518`) and `release-install-smoke.yml`; the smoke script is `.github/scripts/smoke-synthesis.ts`, invoked on artifacts instead of on a downloaded release.*

### Requirement: Linux packages ship only from a release that publishes the same CLI version

A `.deb` or `.rpm` SHALL be published only by the stable release whose version it carries, and that release SHALL publish the same version to npm in the same run. The packaged version is `package.json#version` at the tag, so the release SHALL refuse a tag whose version differs from it. Prerelease tags SHALL ship no packages.

#### Scenario: Maks installs the CLI from apt

- GIVEN a stable tag `vX.Y.Z` is pushed
- WHEN the release workflow runs
- THEN it attaches the `.deb`, the `.rpm` and their `SHA256SUMS` to that release
- AND it publishes `X.Y.Z` to npm in the same run

#### Scenario: The tag names a version the commit does not carry

- GIVEN a tag whose version differs from `package.json#version` at that tag
- WHEN the release workflow classifies it
- THEN it fails before building, naming both versions

#### Scenario: A Prerelease tag is pushed

- GIVEN a tag on the beta or alpha Channel
- WHEN the release workflow runs
- THEN the packages job is skipped and says why

> *Technical Note — `linux-packages.yml:43` keys on the `-cli` marker today; the `packages` job of `release.yml` keys on the stable Channel.*
