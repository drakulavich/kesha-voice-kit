# Tasks: windows-x64-unblock

Ordered so the verification exists before the gate opens. Lane 1 is the one that decides
whether the rest may proceed: if the shipped Windows Engine cannot synthesise or transcribe,
the block was accidentally protecting users and the proposal needs rethinking, not merging.

**Landed as one PR, which makes the verification stronger, not weaker.** The three-lane split
existed to work around a chicken-and-egg problem: while the gate throws, no CI lane can run a
real `kesha install` on Windows, so lane 1 had to pre-place the binary and route around
`fetchEngineBinary` — the very function the gate lives in. Removing the gate in the same commit
dissolves that: `windows-engine-smoke` runs a cold `kesha install` against the published
v1.24.7 asset, which is exactly the path a user takes. The provisioning trick and the separate
task 2.5 are therefore both gone, replaced by one lane that tests the real thing.

If that lane goes red, the unblock does not merge — the sequencing constraint is unchanged, it
is just enforced by CI on this PR instead of by PR ordering.

## 1. Prove the shipped Windows Engine works

- [x] 1.1 `windows-engine-smoke` on `windows-latest`: cold `kesha install --tts en ru`, no
      `KESHA_ENGINE_BIN`, no pre-placed binary — so `fetchEngineBinary` really downloads the
      published asset
- [x] 1.2 Synthesise with both engines: `en-am_michael` (Kokoro) and `ru-vosk-m02` (Vosk) each
      produce a WAV with a valid RIFF/WAVE header and more than a bare 44-byte header
- [x] 1.3 Feed each synthesised WAV back through Transcription and assert non-empty text
- [x] 1.4 Assert the install's ASR warm-up succeeded. It runs by default but is deliberately
      non-fatal (`rust/src/cli/install.rs`), so a Windows ORT failure would otherwise leave
      install reporting success — `.github/scripts/assert-install-warmup.ts`
- [x] 1.5 Close the same gap on Linux: `published-engine-smoke` gains `--tts en ru` and the
      shared `.github/scripts/smoke-synthesis.ts`, since it transcribed a fixture but never
      synthesised
- [x] 1.6 Assert `kesha install --coreml` exits 1 on Windows naming the ONNX backend — only
      meaningful without `KESHA_ENGINE_BIN`, which makes `performInstall` skip the pre-flight
- [x] 1.7 Carry the `release/*` guard so the lane never chases an unpublished tag, and add
      `windows-engine-smoke` to the `ci` aggregator's `needs` so a failure actually blocks
- [ ] 1.8 Record the outcome here (pass, or the exact failure)

## 2. Remove the stale platform gate

- [x] 2.1 `src/engine-install.ts::getEngineBinaryName` returns `kesha-engine-windows-x64.exe`
      for win32-x64 instead of throwing
- [x] 2.2 `src/cli/install.ts::defaultBackendForPlatform` returns `onnx` for win32-x64, and is
      exported. `undefined` would have skipped the pre-flight rather than failing it, letting
      `--coreml` through until the post-download `validateBackend`
- [x] 2.3 Both take optional `platform`/`arch` parameters — the shape
      `isDarwinArm64(platform?, arch?)` already uses — so their win32 branches are testable on
      the ubuntu unit lane
- [x] 2.4 `src/paths.ts::defaultEngineBinPath` keeps the `.exe` suffix on win32. The release
      asset is a PE and `fetchEngineBinary` wrote it to an extensionless path; no lane setting
      `KESHA_ENGINE_BIN` could have caught that, since the override points at a real `.exe`
- [x] 2.5 `src/install-plan.ts::buildEngineComponent` drops the "blocked" note; the stale
      `63_126_528` asset size is refreshed to v1.24.7's 63,447,040 bytes
- [x] 2.6 Unit tests for all of the above; `bun test && bunx tsc --noEmit` green

## 3. Make the docs match the artifacts

- [x] 3.1 `README.md` platform line: Windows x64 supported, naming the macOS-only exclusions
- [x] 3.2 `docs/product-positioning.md`: all seven "Blocked at install (#216)" cells, plus the
      paragraph below the matrix that still recommended the v1.4.x workaround
- [x] 3.3 `openspec/specs/installation/spec.md`: Windows dropped from Open Issues, backend
      Technical Note rewritten, and both new requirements synced from the delta spec
- [x] 3.4 `.github/workflows/ci.yml`: the `published-engine-smoke` P1.10 comment no longer
      justifies omitting Windows by citing the gate this change removes
- [x] 3.5 `docs/tts.md` and `docs/languages.md` already described Linux/Windows as working and
      needed no change; `NOTICES.md`'s #216 reference is historical and stays

## 4. Archive

- [ ] 4.1 Move this change to `openspec/changes/archive/` once CI is green on the Windows lane
