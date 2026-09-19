## 1. Argument handling (TS)

- [x] 1.1 T1-1 validate text (empty, too long, NUL) before voice resolution on both doors; `detect-text-lang` receives text on stdin, never as argv
- [x] 1.2 T1-2 explicit empty positional is `E_TEXT_EMPTY` exit 2 without reading stdin
- [x] 1.3 T1-3 valueless `--out`/`--voice`/`--lang`/`--format`/opus knobs are `E_INVALID_ARG` exit 2; progress line after pre-flight
- [x] 1.4 T1-5 (CLI half) `--bitrate` range 6000..=510000 checked before the spawn
- [x] 1.5 T1-15 (CLI half) a character-device `--out` is refused with `E_INVALID_ARG` naming plain stdout
- [x] 1.6 T1-14 (CLI half) `engineFailure` caps the quoted non-event line at 200 characters and does not re-render it as detail
- [x] 1.7 T2-11 `install --tts <unknown>` is `error [E_INVALID_ARG]: …` exit 2

## 2. Error classes (Rust)

- [x] 2.1 T1-4 / T1-15 `--out` pre-flight in `cli/say.rs::run`: directory, missing parent, unwritable, character device are `E_INVALID_ARG` exit 2 before synthesis; FIFO keeps working
- [x] 2.2 T1-5 `--bitrate` range enforced in `resolve_output_format` before synthesis
- [x] 2.3 T2-3 / T2-4 AVSpeech failures keep their codes: unknown voice is `E_VOICE_UNKNOWN` with the System Settings hint, missing or non-executable sidecar is `E_SIDECAR_MISSING` naming the sibling path; the build-time helper path never appears in a message
- [x] 2.4 T2-5 `exit_code_for_tts_err` is code-aware; `docs/errors.md` exit rows updated
- [x] 2.5 T2-2 the `E_VOICE_UNKNOWN` prefix list is derived from the accepting `cfg` branch
- [x] 2.6 T3-2 SSML parse errors are `E_SSML_INVALID` naming the tag and accepted forms
- [x] 2.7 T3-3 CDATA text is spoken; a genuinely empty SSML document is `E_TEXT_EMPTY`
- [x] 2.8 T3-7 / T1-14 (engine half) FluidAudio's fd 2 is captured and re-emitted as events; unpronounceable text and a rejected token are `E_SCRIPT_UNSUPPORTED`, never a raw line
- [x] 2.9 T4-3 `--rate` validated in the engine (`E_INVALID_ARG` exit 2) on both doors

## 3. SSML and audio on the FluidAudio path (Rust)

- [x] 3.1 T3-4 runs are edge-clipped with `seam` before a `<break>` silence is appended; a break adds only its duration
- [x] 3.2 T4-1 plain text is chunked by a rate-scaled budget and rejoined with `seam::join_chunks`; `--rate 0.5` synthesizes what 1.0 can
- [x] 3.3 T3-6 `<phoneme>` on FluidAudio speaks its wrapped text with a reworded warning; the empty-document bail is coded

## 4. Text normalization and script gates (Rust)

- [x] 4.1 T3-11 / T3-18 text-script classifier with per-voice supported scripts: dominant unsupported script is `E_SCRIPT_UNSUPPORTED` with a hint naming voices that can speak it; a minority run warns naming the tokens; Vosk gets the same gate; NFKC first
- [x] 4.2 T3-12 English currency and comma-grouped numbers verbalized before every English engine, once
- [x] 4.3 T3-15 phone-shaped Russian tokens are read digit by digit; ranges unchanged
- [x] 4.4 T3-14 reproduce against a `main` build; pin the `--no-expand-abbrev` warning with an integration test and fix the dropping layer if it reproduces

## 5. Routing and diagnostics (TS)

- [x] 5.1 T2-10 native-script `ja`/`hi` text routes to an installed AVSpeech voice (male first); the engine hint names the `macos-*` voices that carry the language
- [x] 5.2 T2-6 `status` reports the engine's voice inventory when an engine is installed
- [x] 5.3 T2-7 `kokoro-ane` reports `languagesStaged` and per-language `missing`; `doctor --json` carries the TTS voice and language lists
- [x] 5.4 T2-8 `install --plan --tts <lang>` states the FluidAudio pack bytes from manifest-generated sizes

## 6. Documents and specs

- [x] 6.1 T2-1 `docs/diagnostic-logs.md` Model-cache row and the FluidAudio exception
- [x] 6.2 T2-9 the male-default requirement names both exceptions
- [x] 6.3 T3-1 `docs/tts.md` SSML claims for darwin Kokoro; `<phoneme>` row says the text is read
- [x] 6.4 Spec deltas for `tts-synthesis`, `installation`, `diagnostics`, `engine-contract`; `bun run check:specs`

## 7. Integration

- [x] 7.1 Land the clusters as a stack of three PRs (CLI and input contracts; engine error classes, audio and text; routing and diagnostics), each gated by `just preflight` and `just verify-darwin-full`
- [x] 7.2 Each PR: Greptile P1/P2 clear; adversarial review aimed at "every one of the 31 rows' reproduction commands now behaves as design.md decides, and no minor row, question row or existing test regressed"; CI on the full head SHA
- [x] 7.3 After merge: sync and archive in a follow-up PR
