## Why

The TTS exploratory programme (2026-09-13, four SBTM sessions over `kesha say` against CLI `main` 1.31.0 and engine v1.25.0 darwin-arm64, findings page `18ebf836`) recorded 61 findings, 31 of them **blocker or major**: a written contract in `openspec/specs/tts-synthesis/spec.md`, `docs/tts.md`, `docs/errors.md` or `kesha say --help` says one thing and the product does another. As in the first programme, the rows cluster around a few habits rather than 31 bugs: a caller's mistake is reported as `E_INTERNAL` with a "file a bug" hint (ten rows); a flag or input is accepted silently and the failure surfaces late, or not at all; the diagnostics describe a voice inventory the synthesis path does not have; SSML tags and unsupported scripts produce audio with words missing instead of a warning or a coded refusal. This change fixes all 31 in one PR so the next TTS pass starts from a clean baseline.

## What Changes

- **Argument handling** (T1-1, T1-2, T1-3, T1-5, T2-11, T4-3): the 5000-character and empty-text checks run before text-language detection and never hand the text to a subprocess as an argument, so a NUL byte or a megabyte of stdin is `E_TEXT_TOO_LONG` / `E_TEXT_EMPTY`, never a stack trace; an explicit empty positional is `E_TEXT_EMPTY` without reading stdin; `--out`, `--voice`, `--lang` and `--format` without a value are `E_INVALID_ARG` exit 2 like `--rate` already is; the `--bitrate` range is checked by the CLI before any synthesis; `install --tts <unknown>` is `error [E_INVALID_ARG]: …` exit 2; the engine validates `--rate` itself and answers `E_INVALID_ARG` instead of trapping with status 133.
- **Error classes** (T1-4, T1-14, T1-15, T2-3, T2-4, T2-5, T3-2, T3-3, T3-7): a `--out` path that cannot be written is `E_INVALID_ARG` with the OS reason before synthesis, and a character device or FIFO at `--out` receives the bytes instead of an empty rename; a `macos-*` voice the machine has not downloaded is `E_VOICE_UNKNOWN` with a System Settings hint; a missing or non-executable `say-avspeech` is `E_SIDECAR_MISSING` naming the expected path beside the engine, never a build-machine path; `E_MODEL_MISSING` exits with one status on every engine path; a malformed `<break time>` is `E_SSML_INVALID` naming the attribute and the accepted forms; CDATA text is spoken; text the voice cannot phonemize at all (emoji only, a single token the G2P rejects) is one coded `E_SCRIPT_UNSUPPORTED` line with no raw engine line and no echo of the input.
- **SSML and audio** (T3-4, T3-6, T4-1): a `<break>` adds only the requested silence (segment-edge padding is trimmed at the join); `<phoneme>` on a build without a phoneme path strips the tag and speaks its text; the chunk budget scales with `--rate` so 0.5 synthesizes any text 1.0 can.
- **Text normalization and script gates** (T3-11, T3-12, T3-14, T3-15, T3-18): a Latin-only voice given text entirely in another script is `E_SCRIPT_UNSUPPORTED` before inference; a sentence that mixes a supported script with tokens the voice cannot pronounce is synthesized with one stderr warning naming the tokens; English currency amounts and comma-grouped numbers are verbalized; a Russian phone number written with separators is read digit by digit; `--no-expand-abbrev` warns once on the voices that ignore it, as `--help` promises.
- **Routing and diagnostics** (T2-2, T2-6, T2-7, T2-8, T2-10): the `E_VOICE_UNKNOWN` hint lists every prefix the build routes; `status --json` and `doctor --json` report the same voice inventory as `--list-voices` and mark a Kokoro language whose voice pack is absent as missing; `install --plan --tts <lang>` states the bytes a FluidAudio voice pack will fetch instead of `0 B`; auto-routing for a script the mapped Kokoro voice cannot phonemize prefers an installed `macos-*` voice for that language and, when none exists, fails before inference with a hint naming the voices that could speak it.
- **Documents** (T2-1, T2-9, T3-1): `docs/diagnostic-logs.md` stops promising FluidAudio bundles under `KESHA_HOME`; the "Default voices are male" requirement names both documented exceptions; `docs/tts.md` stops claiming darwin FluidAudio Kokoro rejects `--ssml`; `docs/errors.md` gains the rows this change reclassifies.

Not in scope: the 11 minor, 18 question and 1 idea rows of the same programme; the ONNX build (not covered by the run); FluidAudio's own head and tail padding outside `<break>` joins (T4-8, question); the `KESHA_AVSPEECH_HELPER` variable (T2-16, question).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `tts-synthesis`: validation order and the empty/too-long checks; valueless flags; `--bitrate` range at the CLI; `--out` failure class and device destinations; voice and sidecar error classes; `E_MODEL_MISSING` exit; SSML `<break>` silence, `<phoneme>` degradation, malformed attributes, CDATA; rate-scaled chunking; script gates for Latin-only voices and mixed text; English currency and Russian phone normalization; the `--no-expand-abbrev` warning; the male-default requirement text.
- `installation`: `install --tts <unknown>` exit code and code; `--plan` byte totals for FluidAudio voice packs.
- `diagnostics`: `status --json` and `doctor --json` voice inventory and per-language Kokoro completeness.
- `engine-contract`: `--rate` validated by the engine as `E_INVALID_ARG`; no raw library line reaches the CLI on a coded failure.

## Impact

`src/cli/say.ts`, `src/synth.ts`, `src/voice-routing.ts`, `src/status.ts`, `src/doctor.ts`, `src/engine-install.ts` (plan sizes, `--tts` validation), `src/cli/install.ts`; `rust/src/cli/say.rs`, `rust/src/tts/{say,fluid_kokoro,avspeech,encode,seam,wav}.rs`, `rust/src/tts/ssml/*`, `rust/src/tts/normalize/*`, `rust/src/tts/en/*`, `rust/src/tts/ru/*`, `rust/src/errors.rs`, `rust/src/protocol/describe.rs`; `docs/tts.md`, `docs/errors.md`, `docs/diagnostic-logs.md`; `tests/helpers/fake-engine.ts` where the describe document changes. No protocol version change. Engine-side fixes reach users with the next engine release; CLI-side fixes with the next CLI release.
