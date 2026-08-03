## MODIFIED Requirements

### Requirement: Every shipped platform is verified end to end before release

For each platform whose Engine is published, the release pipeline SHALL verify that the
shipped binary performs real synthesis and real Transcription — not only that it builds
and passes unit tests. A platform whose Engine ships without that verification SHALL be
documented as unverified rather than presented as supported.

Verification SHALL cover both the asset a user downloads today and the artifact a release is
about to publish. These are different binaries reached by different means: a release branch
cannot download its own Engine, because its tag does not exist until the release is un-drafted.

The artifact half SHALL be satisfied by the uploaded bytes themselves. A separate compilation
with the same features on a second runner is a reproduction, not the artifact, and SHALL NOT
be treated as evidence that the published binary synthesises. The build pipeline SHALL
therefore synthesise through the staged binary before that binary is uploaded, and SHALL fail
the build rather than upload an Engine that cannot synthesise.

Advertising a capability SHALL NOT be accepted as evidence of it. An Engine that starts and
reports `tts` in its Capabilities JSON while failing at synthesis SHALL fail the pre-upload
gate.

Because the install-time ASR warm-up is non-fatal by design, a successful `kesha install`
SHALL NOT by itself be treated as evidence that the Engine initialises on that platform.

#### Scenario: Smoke on the published asset

- GIVEN release v`<engineVersion>` publishes an Engine asset for a platform
- WHEN the published-asset smoke lane runs on that platform
- THEN it performs a cold `kesha install`, synthesises through `kesha say`, and
  transcribes the result back
- AND the lane does not run on `release/*` branches, whose tag is not yet published

#### Scenario: The artifact synthesises before it is uploaded

- GIVEN the build pipeline has staged the Engine binary for a platform under its release
  asset name
- WHEN the pre-upload smoke runs on that platform
- THEN the CLI is pointed at that staged binary and synthesises English speech to a file
- AND the file carries a RIFF/WAVE header and audio beyond the header
- AND the upload step runs only after that check passes

#### Scenario: No TTS engine can run on a platform's build runner

- GIVEN every TTS engine available to the darwin-arm64 Engine needs hardware the build runner
  does not provide
- WHEN the release build runs on that platform
- THEN the pre-upload synthesis gate does not run there
- AND that platform is recorded as having unverified synthesis, not reported as verified

#### Scenario: Capabilities advertise TTS but synthesis is broken

- GIVEN a staged Engine that starts and reports `tts` in its Capabilities JSON
- AND its first synthesis call fails
- WHEN the pre-upload smoke runs
- THEN the build fails on that platform
- AND no Engine artifact is uploaded for it

#### Scenario: Ira changes the pre-upload gate

- GIVEN Ira edits the release build pipeline, which normal pull-request lanes never execute
- WHEN Ira runs the pipeline manually against the branch without naming a tag
- THEN the build and its pre-upload smoke run on every platform
- AND nothing is tagged, released, or published

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

> *Technical Note — sources: `.github/workflows/ci.yml` (`published-engine-smoke` on
> ubuntu-latest, `windows-engine-smoke` on windows-latest — both run a cold install and
> `.github/scripts/smoke-synthesis.ts`; `release-branch-engine-smoke` builds a local Engine and
> reaches it through `KESHA_ENGINE_BIN` plus a sibling `.version` file),
> `.github/workflows/build-engine.yml` (the `Smoke-test binary` step, which today asserts only
> on `--capabilities-json` and, on macOS, `say --list-voices`; its `build` job runs on
> `workflow_dispatch` with an empty `tag`, while the `release` job is gated on
> `startsWith(github.ref, 'refs/tags/v')`), `.github/scripts/assert-install-warmup.ts`, and
> `rust/src/cli/install.rs` (warm-up warns and continues, #298).*

## Open Issues

- Cache scope on tag-triggered runs: a branch `workflow_dispatch` restores the `main`-scoped
  entry, observed. The `refs/tags/v*` case is inferred from the same default-branch scope, not
  observed, and can only be observed on a real release.
- darwin synthesis has no CI coverage by either engine. Kokoro pins its vocoder stage to
  `.cpuAndNeuralEngine` and the `macos-14` runner is an ANE-less VM; the AVSpeech sidecar times
  out on every voice tried, including an OS-bundled compact one, for reasons not yet
  established. Both engines work on real Apple Silicon, so this is a coverage gap, not a known
  defect. Tracked in #678; darwin's only synthesis verification remains the manual draft-asset
  check in CLAUDE.md.
- Engine version marker: `release-branch-engine-smoke` writes `${KESHA_ENGINE_BIN}.version`
  from `package.json#keshaEngine.version`. On a release build the tag is the authority for
  that version, and whether the two can disagree mid-release is not established here.
