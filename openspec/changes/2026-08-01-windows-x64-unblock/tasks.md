# Tasks: windows-x64-unblock

Ordered so the verification exists before the gate opens. Lane 1 is the one that decides
whether the rest may proceed: if the shipped Windows Engine cannot synthesise or transcribe,
the block was accidentally protecting users and the proposal needs rethinking, not merging.

## 1. Prove the shipped Windows Engine works (PR lane 1 — `ci-real-synth-smoke`)

- [ ] 1.1 Add a release-smoke job on `windows-latest` that downloads the published
      `kesha-engine-windows-x64.exe`, runs `--capabilities-json`, and asserts protocol
      version 3 plus the expected ONNX feature set
- [ ] 1.2 Extend it to synthesise: `kesha say --voice en-am_michael` and
      `--voice ru-vosk-m02` each produce a non-empty WAV with a valid RIFF header
- [ ] 1.3 Feed the synthesised WAV back through Transcription and assert non-empty text
- [ ] 1.4 Mirror the lane on `ubuntu-latest` — the same verification gap exists there
- [ ] 1.5 Record the outcome in this change's Open Issues (pass, or the exact failure)

## 2. Remove the stale platform gate (PR lane 2 — `fix-windows-install-gate`)

Blocked by lane 1.

- [ ] 2.1 `src/engine-install.ts::getEngineBinaryName` returns
      `kesha-engine-windows-x64.exe` for win32-x64 instead of throwing; unit test
- [ ] 2.2 `src/cli/install.ts::defaultBackendForPlatform` returns `onnx` for win32-x64;
      unit test covering auto-detection and `--coreml` rejection on Windows
- [ ] 2.3 `src/install-plan.ts::buildEngineComponent` drops the "blocked by the install
      path" note; unit test asserting the plan carries no block statement
- [ ] 2.4 Gate `bun test && bunx tsc --noEmit`, commit

## 3. Make the docs match the artifacts (PR lane 3 — `docs-windows-supported`)

Blocked by lane 2.

- [ ] 3.1 `README.md` platform line: Windows x64 supported with the ONNX capability set,
      minus recording and the macOS-only capabilities
- [ ] 3.2 `docs/product-positioning.md`: replace the four "Blocked at install (#216)" cells
      and rewrite the paragraph below the matrix
- [ ] 3.3 `openspec/specs/installation/spec.md`: drop the Windows entry from Open Issues and
      the "temporarily unsupported" clause from the backend Technical Note
- [ ] 3.4 Check `docs/tts.md`, `docs/languages.md`, and `docs/errors.md` for statements that
      assumed the block; leave the macOS-only rows untouched
- [ ] 3.5 Gate `bun run check:specs`, commit

## 4. Archive

- [ ] 4.1 Move this change to `openspec/changes/archive/` once lanes 1-3 have merged
