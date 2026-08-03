## Why

`build-engine.yml` smoke-tests the exact binary it is about to upload, but only for
`--capabilities-json` (plus a voice-list check on macOS). An Engine that links, starts, and
advertises `"tts"` while failing at its first ONNX session passes that gate and ships. The
three lanes that do prove synthesis all test a *different* binary — either the
already-published asset of the current `keshaEngine.version`, or a second compilation on a
second runner — so no lane exercises the artifact a release is about to publish.

The installation spec already requires that verification "cover both the asset a user
downloads today and the artifact a release is about to publish". Today only the first half is
mechanised; the second is a human step in CLAUDE.md ("validate the draft binary first with
authenticated `gh release download` … and exercise it end-to-end"). This change closes the
gap the spec already asserts.

## What Changes

- The pre-upload smoke in `build-engine.yml` performs a real synthesis round-trip on every
  matrix row, against the staged artifact, before `actions/upload-artifact` runs.
- The round-trip is driven through the CLI pointed at the staged binary via
  `KESHA_ENGINE_BIN` + a sibling `.version` file — the same mechanism
  `release-branch-engine-smoke` already uses — so the artifact is exercised through the
  Engine contract users hit, not a bespoke invocation.
- Models come from `install-kesha-backend`, the existing composite action, keeping the
  no-auto-download rule intact: the download is an explicit, named step.
- The existing `--capabilities-json` assertions stay exactly as they are; the synthesis
  round-trip is added after them, not in place of them.
- linux-x64 and windows-x64 synthesise `en-am_michael` after `kesha install --tts en`.
  darwin-arm64 synthesises through AVSpeech instead: FluidAudio pins the Kokoro vocoder to the
  Neural Engine, which GitHub's `macos-14` VM does not expose (#678). AVSpeech needs no models
  and covers the Swift sidecar's spawn path, asserted only at list level today.

## Capabilities

### New Capabilities

None. This change mechanises an obligation the `installation` spec already states.

### Modified Capabilities

- `installation`: the "Every shipped platform is verified end to end before release"
  requirement gains a scenario for the pre-upload artifact gate, and its wording tightens
  from "the artifact a release is about to publish" being covered by a faithful rebuild to
  being covered by the uploaded bytes themselves.

## Non-goals

- **No transcription round-trip on the release build.** `.github/scripts/smoke-synthesis.ts`
  transcribes its own output back, which needs the multi-GB ASR model set on the release
  runner. Synthesis correctness is the bug class #636 names; ASR on the shipped artifact stays
  with the published-asset lanes.
- **No accuracy assertion.** The gate proves the Engine speaks, not that it speaks well —
  same posture as the existing round-trip script ("Not asserting on WER").
- **No new coverage for Russian / non-English voices on linux and windows.** English only, to
  keep one model download per platform per release.
- **No CI coverage of darwin Kokoro.** Not achievable on an ANE-less runner; tracked in #678,
  and recorded in the spec as a known gap rather than an assumed pass.
- **No change to the release job, the publish path, or the draft-validation step in
  CLAUDE.md.** The human end-to-end check on the draft asset stays until this gate has proven
  itself across a release or two.
- **No change to `ci.yml`'s existing smoke lanes.** They cover a different binary on purpose.

## Impact

- `.github/workflows/build-engine.yml` — the most release-critical workflow in the repo; a
  broken edit here breaks releases and cannot be caught by `main`'s normal PR lanes. The
  verification path for this change is the workflow's own `workflow_dispatch` with an empty
  `tag` input, which runs `build` on a branch ref while `release` stays gated on
  `startsWith(github.ref, 'refs/tags/v')`.
- `.github/scripts/` — a synthesis-only entry point, split out of `smoke-synthesis.ts` so the
  two callers share one definition of "did it synthesise".
- Release wall-clock and cost: one English Kokoro download per non-Darwin release build,
  amortised by the existing `main`-scoped model cache.
- Closes #671 and #636. Refs #216, #464, #667.
