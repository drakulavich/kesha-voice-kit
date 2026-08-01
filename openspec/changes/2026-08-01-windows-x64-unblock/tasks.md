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
- [x] 1.8 Keep the lane cold across runs: the model cache excludes `~/.cache/kesha/engine`,
      because restoring the binary and its version marker sends `downloadEngine` down the
      cacheValid branch and the download path stops being tested from run two onward
      (Greptile P1). The lane asserts the engine is absent before install and that the install
      log says it downloaded
- [x] 1.9 `release-branch-engine-smoke` gains `--tts en ru` and the same synthesis script, and
      `release-branch-windows-smoke` is its win32 counterpart — building the engine with MSVC
      rather than downloading a tag that does not exist yet. Without it the Windows binary about
      to ship would be the one published artifact with no synthesis proof, since
      `windows-engine-smoke` is guarded off `release/*`
- [x] 1.10 Outcome recorded below

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

## Outcome

`windows-engine-smoke` passed on 2026-08-01 (run 30707424619, 3m38s), against the published
v1.24.7 `kesha-engine-windows-x64.exe` fetched by a cold `kesha install`:

```
Waiting for the engine binary to be released by the system...
Engine binary downloaded (v1.24.7).
ok: ASR backend warmed up during install
ok: en-am_michael synthesised 355258 bytes
ok: en-am_michael round-tripped to ", The quick brown fox jumps over the lazy dog."
ok: ru-vosk-m02 synthesised 219194 bytes
ok: ru-vosk-m02 round-tripped to "Проверка синтеза речи на русском языке."
```

**Issue #216's last acceptance criterion is met**: `kesha say --voice ru-vosk-m02` produces a
valid WAV on Windows — demonstrated rather than assumed, for the first time since the vendoring
landed on 2026-04-30. `published-engine-smoke` passed the same round-trip on Linux.

The lane paid for itself before it went green. Three defects it found, none of which any
existing test could have:

1. `streamResponseToFile` never awaited `writer.end()`, so the write handle outlived the
   download and the engine could not be spawned — `EBUSY` 15 ms later. Latent on Linux too, as
   `ETXTBSY`.
2. A security scanner holds a newly written 60 MB PE; the `Waiting for...` line above is that
   lock being waited out. Without it the first `kesha install` on a stock Windows machine fails.
3. `defaultEngineBinPath` wrote the `.exe` asset to an extensionless path.

Two Open Issues from the proposal are now closed by this evidence: the Windows synthesis
criterion, and the install-time warm-up, which is asserted rather than assumed because it is
non-fatal by design.
