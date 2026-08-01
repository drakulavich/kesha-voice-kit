# Tasks: windows-x64-unblock

Ordered so the verification exists before the gate opens. Lane 1 is the one that decides
whether the rest may proceed: if the shipped Windows Engine cannot synthesise or transcribe,
the block was accidentally protecting users and the proposal needs rethinking, not merging.

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

- [ ] 1.1 Windows published-asset lane on `windows-latest`: `gh release download v<engineVersion>`
      for `kesha-engine-windows-x64.exe`, provision as above, then `--capabilities-json` asserting
      protocol version 3 and the ONNX feature set
- [ ] 1.2 Extend it to synthesise: `kesha say --voice en-am_michael` and
      `--voice ru-vosk-m02` each produce a non-empty WAV with a valid RIFF header
- [ ] 1.3 Feed the synthesised WAV back through Transcription and assert non-empty text
- [ ] 1.4 Add synthesis (1.2 + 1.3) to the existing `published-engine-smoke` job — it transcribes
      a fixture today but never synthesises, so Linux carries the same gap
- [ ] 1.5 Cover the pre-publication artifact: add synthesis to `release-branch-engine-smoke` and
      give it a `windows-latest` counterpart that builds the Engine locally
      (`cargo build --release --features onnx,tts --no-default-features`) rather than downloading a
      tag that does not exist yet
- [ ] 1.6 Reuse the `release/*` guard from `integration-tests-full` on the published lane, so it
      never tries to download an unpublished tag on a release PR
- [ ] 1.7 Record the outcome in this change's Open Issues (pass, or the exact failure)

## 2. Remove the stale platform gate (PR lane 2 — `fix-windows-install-gate`)

Blocked by lane 1.

- [ ] 2.1 `src/engine-install.ts::getEngineBinaryName` returns
      `kesha-engine-windows-x64.exe` for win32-x64 instead of throwing; unit test
- [ ] 2.2 `src/cli/install.ts::defaultBackendForPlatform` returns `onnx` for win32-x64.
      It is module-private today — export it, as `resolveBackendFlag` and `resolveTtsLangs`
      already are, so the unit test can cover auto-detection and `--coreml` rejection
      directly rather than through `performInstall`'s `process.exit`
- [ ] 2.3 `src/install-plan.ts::buildEngineComponent` drops the "blocked by the install
      path" note; unit test asserting the plan carries no block statement
- [ ] 2.4 Gate `bun test && bunx tsc --noEmit`, commit

## 3. Make the docs match the artifacts (PR lane 3 — `docs-windows-supported`)

Blocked by lane 2.

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
