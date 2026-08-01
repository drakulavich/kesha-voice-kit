# Tasks: windows-x64-unblock

Ordered so the verification exists before the gate opens. Lane 1 is the one that decides
whether the rest may proceed: if the shipped Windows Engine cannot synthesise or transcribe,
the block was accidentally protecting users and the proposal needs rethinking, not merging.

**Lane 1 proves the Engine runs, not that the install works.** Its provisioning deliberately
routes around `fetchEngineBinary` — which is where the gate lives — so it cannot exercise the
download path that lane 2 opens. That path gets its own gate in section 2 (task 2.5), and
section 3 is blocked on *that*, not on lane 1. Keeping the two claims apart is the point:
"the shipped binary speaks" and "Windows is a supported install target" are different
statements needing different evidence.

## 1. Prove the shipped Windows Engine works (PR lane 1 — `ci-real-synth-smoke`)

Two lanes, not one, mirroring the split `ci.yml` already draws on Linux: `published-engine-smoke`
covers the asset users actually download, and `release-branch-engine-smoke` covers the artifact a
release is about to ship (which cannot be downloaded — its tag does not exist yet). Only the
published lane gates section 2: it is the one that answers "does the binary the CLI would fetch
today actually speak".

**Provisioning (applies to both lanes).** `kesha install` cannot fetch the Engine on Windows while
`getEngineBinaryName` throws — but it does not have to. `downloadEngine` reaches that throw only
via `fetchEngineBinary`, which is skipped when `getEngineBinPath()` already holds a binary whose
`.version` marker matches `package.json#keshaEngine.version` (`engine-install.ts:519-528`). So each
lane sets `KESHA_ENGINE_BIN`, places the Engine there, writes the marker — the pattern
`release-branch-engine-smoke` already uses at `ci.yml:515-520` — and only then runs
`kesha install --onnx --tts en ru`, which provisions the ASR, Kokoro, and Vosk models through the
Engine's own `install` subcommand. No gate is in the path, and no darwin assets are fetched:
`downloadSidecar` returns early on `!isDarwinArm64()`.

Two costs of that trick, both accepted here and paid back in 2.5. Setting `KESHA_ENGINE_BIN`
also disables the backend pre-flight (`install.ts:156` guards on `!process.env.KESHA_ENGINE_BIN`),
so lane 1 cannot exercise `--coreml` rejection end to end. And pointing it at a `.exe` sidesteps
the extensionless default path (see 2.5).

- [ ] 1.1 Windows published-asset lane on `windows-latest`: `gh release download v<engineVersion>`
      for `kesha-engine-windows-x64.exe` (pass `GH_TOKEN: ${{ github.token }}`), provision as
      above with `KESHA_ENGINE_BIN` ending in `.exe`, then `--capabilities-json` asserting
      protocol version 3 and the ONNX feature set
- [ ] 1.2 Extend it to synthesise: `kesha say --voice en-am_michael` and
      `--voice ru-vosk-m02` each produce a non-empty WAV with a valid RIFF header
- [ ] 1.3 Feed the synthesised WAV back through Transcription and assert non-empty text
- [ ] 1.4 Assert the install's ASR warm-up succeeded. It runs by default but is deliberately
      non-fatal (`rust/src/cli/install.rs:74-84` warns and continues), so a Windows ORT session
      failure would leave install reporting success. Fail the lane on that `warning:` line —
      otherwise the warm-up Open Issue survives a green lane 1
- [ ] 1.5 Add synthesis (1.2 + 1.3) to the existing `published-engine-smoke` job — it transcribes
      a fixture today but never synthesises, so Linux carries the same gap. Windows must not reuse
      its `ffmpeg-provider: apt` input (`ci.yml:455`); the Engine needs no ffmpeg, so pass `skip`
- [ ] 1.6 Cover the pre-publication artifact: add synthesis to `release-branch-engine-smoke` and
      give it a `windows-latest` counterpart that builds the Engine locally
      (`cargo build --release --features onnx,tts --no-default-features`) rather than downloading a
      tag that does not exist yet. Carry over the three Windows build prerequisites from
      `rust-test.yml:117-155` — `ilammy/msvc-dev-cmd`, the `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER`
      pin that stops Git's GNU `link.exe` shadowing MSVC's, and `CMAKE_POLICY_VERSION_MINIMUM=3.5`
      for the vendored opus cmake fallback — or the lane fails at link time for reasons unrelated
      to this change. Cargo emits `kesha-engine.exe`, so the Linux job's extensionless
      `KESHA_ENGINE_BIN` (`ci.yml:489`) cannot be copied verbatim
- [ ] 1.7 Reuse the `release/*` guard from `integration-tests-full` on the published lane, so it
      never tries to download an unpublished tag on a release PR
- [ ] 1.8 Give the Windows lanes their own timeouts and model cache. Linux
      `release-branch-engine-smoke` is already 25 minutes (`ci.yml:486`); a Windows cargo build plus
      dual-voice model download will exceed that
- [ ] 1.9 Record the outcome in this change's Open Issues (pass, or the exact failure)

## 2. Remove the stale platform gate (PR lane 2 — `fix-windows-install-gate`)

Blocked by lane 1.

- [ ] 2.1 `src/engine-install.ts::getEngineBinaryName` returns
      `kesha-engine-windows-x64.exe` for win32-x64 instead of throwing; unit test
- [ ] 2.2 `src/cli/install.ts::defaultBackendForPlatform` returns `onnx` for win32-x64.
      It is module-private today — export it, as `resolveBackendFlag` and `resolveTtsLangs`
      already are, so the unit test can cover auto-detection and `--coreml` rejection
      directly rather than through `performInstall`'s `process.exit`
- [ ] 2.3 Both functions read `process.platform`/`process.arch` with no parameters, and
      unit-tests run on ubuntu — so their win32 branches are untestable as written. Take optional
      `platform`/`arch` parameters, the shape `isDarwinArm64(platform?, arch?)` already uses in
      `src/fluid-kokoro-cache.ts`. Without this, 2.1 and 2.2's tests assert nothing on CI
- [ ] 2.4 Decide the Windows binary path. `defaultEngineBinPath` (`src/paths.ts:8-10`) returns an
      extensionless `kesha-engine`, and `fetchEngineBinary` writes the `.exe` asset straight to it
      (`engine-install.ts:416`). Whether Bun can spawn an extensionless PE on Windows is unverified
      — and lane 1 cannot tell us, because it points `KESHA_ENGINE_BIN` at a real `.exe`. Either
      append `.exe` on win32 or prove the extensionless path spawns; do not leave it to the first
      user. `chmodSync(binPath, 0o755)` on the same line is a Windows no-op and is fine
- [ ] 2.5 **Cold-install gate.** A `windows-latest` job with no `KESHA_ENGINE_BIN` and no
      pre-placed binary or marker, running bare `kesha install --tts en ru` so `fetchEngineBinary`
      really downloads the asset to the default path, then synthesis + Transcription. This is the
      job that earns the word "supported", and section 3 is blocked on it — lane 1 deliberately
      cannot reach this path. Also assert `kesha install --coreml` exits 1 here, since the
      pre-flight only engages without `KESHA_ENGINE_BIN`
- [ ] 2.6 `src/install-plan.ts::buildEngineComponent` drops the "blocked by the install
      path" note; unit test asserting the plan carries no block statement. While here, refresh the
      stale `63_126_528` size at `install-plan.ts:115` — v1.24.7's asset is 63,447,040 bytes
- [ ] 2.7 Gate `bun test && bunx tsc --noEmit`, commit

## 3. Make the docs match the artifacts (PR lane 3 — `docs-windows-supported`)

Blocked by task 2.5 specifically, not merely by lane 2 landing. Docs may not call Windows
supported until a cold `kesha install` has been shown to work there.

- [ ] 3.1 `README.md` platform line: Windows x64 supported with the ONNX capability set,
      minus recording and the macOS-only capabilities
- [ ] 3.2 `docs/product-positioning.md`: replace the seven "Blocked at install (#216)" cells
      (STT, audio language detection, VAD, Kokoro, Vosk-TTS, OpenClaw, Hermes) and rewrite the
      paragraph below the matrix, which still names the v1.4.x workaround and calls the toolkit
      "unusable on Windows". Leave the "Not applicable" rows alone
- [ ] 3.3 `openspec/specs/installation/spec.md`: drop the Windows entry from Open Issues and
      the "temporarily unsupported" clause from the backend Technical Note
- [ ] 3.4 `.github/workflows/ci.yml:414-417`: the `published-engine-smoke` P1.10 comment
      justifies omitting Windows by citing the very gate lane 2 removes — rewrite it once the
      Windows lane from 1.1 exists
- [ ] 3.5 Check `docs/tts.md`, `docs/languages.md`, and `docs/errors.md` for statements that
      assumed the block; leave the macOS-only rows untouched. `NOTICES.md`'s #216 reference is
      historical (it records the vendoring) and stays as written
- [ ] 3.6 Gate `bun run check:specs`, commit

## 4. Archive

- [ ] 4.1 Move this change to `openspec/changes/archive/` once lanes 1-3 have merged
