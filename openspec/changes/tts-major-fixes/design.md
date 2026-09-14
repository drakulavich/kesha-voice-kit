## Context

The 31 rows come from four exploratory sessions against the released engine v1.25.0 and the CLI on `main`. The code map for this change (`scratchpad/xt-tts/code-map.md` in the session that ran it) established that `main` fixes none of them: PR #1216 touched no file under `rust/src/tts/` and not `rust/src/cli/say.rs`; its only overlap is the `record --out` probe, which is why T1-4's `record` half is already `E_INVALID_ARG`. Every decision below therefore starts from the code as it is on `main` at `f3786409`.

Two boundaries shape the design. FluidAudio (darwin-arm64 Kokoro) has no IPA input path, an internal G2P with a 2000-acoustic-frame cap per call and a ~100-character word limit, writes its own diagnostics to file descriptor 2, and traps on a rate of 0. The CLI talks to the engine over protocol 4 and quotes any non-event stderr line as `E_INTERNAL`. Fixes are placed on the side that can decide correctly: the CLI validates what it can validate without a model, the engine validates its own arguments and classifies its own failures, and nothing user-typed is ever passed to a subprocess as an argv element.

## Goals / Non-Goals

**Goals:**
- Every caller error on the `say` path carries the code `docs/errors.md` documents for it and the exit code of its class; `E_INTERNAL` is left for failures nobody predicted.
- No input reaches a subprocess as an argument; the empty and too-long checks run first and the same way on every door.
- What the diagnostics report about voices is what the synthesis path can use.
- SSML tags degrade the documented way (tag stripped, text kept); a `<break>` is the silence asked for; the frame cap is never visible to the user.
- Text that a voice cannot pronounce is refused before inference when it is the whole input, and announced when it is a minority of it.

**Non-Goals:**
- Honouring `<phoneme ph>` on FluidAudio (no API; the tag degrades to its text).
- FluidAudio's own utterance padding outside `<break>` joins (T4-8, question row).
- The ONNX build's behaviour for the same rows (not covered by the run; the engine-side changes are cfg-neutral where they can be and gated where they cannot).
- `say()` rate bounds in the core API (T4-2, question row); the engine-side bound added here covers it indirectly.
- `KESHA_AVSPEECH_HELPER` (T2-16, question row).

## Decisions

### D1. Validation order and the argv hop (T1-1, blocker)
`src/cli/say.ts` validates the resolved text (empty, whitespace-only, `> MAX_TEXT_CHARS` code points, a NUL byte) immediately after `resolveText` and before `resolveSayVoice`; `say()` in `src/synth.ts` keeps the same checks for programmatic callers through one shared `validateSayText`. Text-language detection stops passing the text as an argv element: `detectTextLanguageEngine` writes it to the subprocess's stdin (the engine's `detect-text-lang` reads stdin when no argument is given; add that reading path if absent). A NUL byte is `E_INVALID_ARG` ("text contains a NUL byte"), not `E_TEXT_EMPTY`. `MAX_TEXT_CHARS = 5000` stays the single number, mirrored by `rust/src/tts/say.rs` as today.

### D2. Explicit empty positional and valueless flags (T1-2, T1-3)
`resolveText` distinguishes an absent positional from a present empty one: `kesha say ""` is `E_TEXT_EMPTY` exit 2 without touching stdin, regardless of TTY. A string-typed flag that citty hands back as `true` or `""` (`--out`, `--voice`, `--lang`, `--format`, `--bitrate`, `--sample-rate`, `--rate`) is `error [E_INVALID_ARG]: --out needs a value` exit 2 through one `requireFlagValue` helper; `undefined` and `false` keep meaning absent. The `Synthesizing …` progress line moves after all pre-flight checks.

### D3. Opus knobs are checked by the CLI, and the engine before synthesis (T1-5)
`src/cli/say.ts::parseBitrateFlag` enforces 6000..=510000 (exit 2, instant). `rust/src/cli/say.rs::resolve_output_format` enforces the same range before `tts::say` runs, returning `InvalidArg` exit 2, so a direct engine caller gets the same answer; the encoder keeps its check as defence in depth.

### D4. `--out` pre-flight in the engine, and device destinations (T1-4, T1-15)
`rust/src/cli/say.rs::run` probes `--out` before `tts::say` the way `rust/src/record.rs::WavOutput::open` does: a directory, a missing parent, an unwritable location are `E_INVALID_ARG` with the OS reason, exit 2. A character device (`/dev/stdout`, `/dev/stderr`, `/dev/fd/*`, `/dev/null` included) is refused as `E_INVALID_ARG` naming the plain-stdout default, because the engine's stdout is the CLI's pipe and the bytes would vanish; a FIFO and a regular file keep working. The CLI performs the same character-device check first (no spawn) so the message is identical from both doors. After a passed probe, a write failure stays `E_INTERNAL`. `say` keeps `std::fs::write` semantics (no `.partial` sibling): a FIFO destination must keep streaming.

### D5. Coded failures on the AVSpeech path and the exit-code rule (T2-3, T2-4, T2-5)
`rust/src/tts/say.rs::say_avspeech` stops collapsing the sidecar's coded errors into `SynthesisFailed`; it maps them through `TtsError::Coded { code: code_of(&e) }` like the FluidAudio arm. The sidecar contract is made explicit: `swift/say-avspeech` exits 2 with `voice not found: <id>` for an unknown voice, and `rust/src/tts/avspeech.rs` turns exit status 2 with that prefix into `E_VOICE_UNKNOWN` (hint: "download the voice in System Settings > Accessibility > Spoken Content, or pick one from `kesha say --list-voices`"), any other non-zero exit or a spawn failure into `E_SIDECAR_MISSING` (hint: "reinstall with `kesha install`; the sidecar must sit beside kesha-engine at <path>"). The build-time `env!("KESHA_AVSPEECH_HELPER")` path never appears in a user message: the reported path is the sibling-of-exe location. `rust/src/cli/say.rs::exit_code_for_tts_err` becomes code-aware: `ModelMissing`, `ModelDownload`, `CacheCorrupt`, `ModelLoad`, `SidecarMissing`, `VoiceUnknown` exit 1; `InvalidArg`, `SsmlInvalid`, `TextEmpty`, `TextTooLong` exit 2 where the CLI already uses 2 for them, else the documented class; `ScriptUnsupported` and `SsmlUnsupported` keep 4 as documented; `Internal` 4. `docs/errors.md` is updated where a row's exit changes.

### D6. `E_VOICE_UNKNOWN` hint lists what the build routes (T2-2)
`rust/src/tts/voices.rs::resolve_voice` derives the prefix list in the message from the same `cfg` branch that accepts the prefixes (one `SUPPORTED_PREFIXES` per branch), so `zh`, `ja`, `hi` appear on the build that serves them and not elsewhere.

### D7. SSML parse errors, CDATA and empty documents (T3-2, T3-3)
`rust/src/tts/ssml/mod.rs::parse` wraps `parse_ssml` with `.coded(ErrorCode::SsmlInvalid)` and prefixes the upstream message with the tag and accepted forms it can infer ("`<break time>` must be `Nms`, `Ns` or absent"). CDATA content is preserved as text (substituted before parsing or read from the raw span). The three "no speakable content" bails become `TtsError::Coded { code: TextEmpty }` for a document that is genuinely empty after that.

### D8. `<phoneme>` degrades to its text on FluidAudio (T3-6)
`Segment::Ipa` carries the wrapped text; `FluidKokoroSink::unit` speaks that text instead of returning `None`, with the existing once-per-run warning reworded to say the contained text is read. The ONNX sink keeps feeding `ph`. The "no audio produced from SSML input" bail is coded `TextEmpty` like D7.

### D9. Seam trimming at breaks and rate-aware chunking (T3-4, T4-1)
The FluidAudio arm adopts `rust/src/tts/seam.rs`: every synthesized run is clipped at its edges with `clip_edges` before the deliberate `<break>` silence is appended, so a break adds only its own duration (the 30 s cap unchanged). Plain text on the FluidAudio path is chunked before `fluid_kokoro::synthesize` with a budget that divides by `speed` (conservative character-based estimate under the 2000-frame cap, sentence and clause boundaries preferred) and rejoined with `seam::join_chunks`, so `--rate 0.5` synthesizes any text `--rate 1.0` can. The chunker and the seam handling are one module used by both the break path and the long-text path.

### D10. The FluidAudio stderr channel and the CLI's quoted line (T1-14, T3-7)
`rust/src/fluid_stdout.rs` grows a sibling that captures file descriptor 2 across the FluidAudio bridge and re-emits each captured line as one `events::warn` (or as the detail of the coded error when the call failed), so no raw library line reaches the CLI. Text with no alphanumeric character on the plain path (emoji only) is refused before the model with `E_SCRIPT_UNSUPPORTED` ("no pronounceable content for voice <id>"), the guard `synthesize_pcm` already has for SSML segments being kept tolerant there. A single token FluidAudio's G2P rejects (the ~100-character word) is reported as `E_SCRIPT_UNSUPPORTED` naming the token's first 40 characters, not as `E_INTERNAL`. On the CLI side `src/engine/events.ts::engineFailure` caps the quoted non-event line at 200 characters and never re-renders it a second time as `detail`.

### D11. Engine-side `--rate` validation (T4-3)
`rust/src/cli/say.rs::run` (and the `--stdin-loop` door) refuses a non-finite or out-of-range `--rate` with `E_INVALID_ARG` exit 2 before any engine is chosen, using `compose_rate`'s bounds `0.5..=2.0` as the single source. A trap in Swift can produce no payload, so the refusal must be pre-flight.

### D12. Script gates by text, not by voice language (T3-11, T3-18)
`rust/src/tts/fluid_kokoro.rs::unsupported_native_script` is replaced by a text classifier: after NFKC normalisation (fullwidth Latin becomes Latin), the letters of the input are bucketed by script, and each voice declares the scripts its G2P handles (`en-*`, `es/fr/it/pt-*`: Latin; `ru-vosk-*`: Cyrillic; `zh-*`: Han plus Latin; `hi-*`/`ja-*` on FluidAudio: Latin only, as today). When the dominant script (more than half of the letters) is unsupported, the run fails before inference with `E_SCRIPT_UNSUPPORTED` naming the script and the voice, and the hint lists installed voices that handle it (D14 supplies the list on darwin). When a minority run is unsupported, synthesis proceeds and one `warn` names the tokens that will be mispronounced ("2 tokens in Latin script cannot be pronounced by ru-vosk-m02: Kesha, Voice"). The Vosk path gains the same classifier (it has no gate today). Existing behaviour is preserved for `hi`/`ja` native script (refused) and `zh` Han (supported).

### D13. English currency and comma-grouped numbers; Russian phone tokens (T3-12, T3-15)
A new `rust/src/tts/en/numbers.rs` verbalizes `$N`, `$N.NN`, `N,NNN[,NNN]`, and `N.NN` after a currency sign ("one thousand two hundred thirty four dollars and fifty six cents"; `€`, `£` alongside `$`) before the text reaches any English engine, including the FluidAudio handoff in `say_fluid_kokoro` and `FluidKokoroSink::unit`; the ONNX path calls it once, from `en::normalize_segments`, to avoid double expansion. `rust/src/tts/ru/numbers.rs` recognises a phone-shaped token (leading `+` or `8`, digits with spaces, hyphens or parentheses, ten or more digits in total) before the run splitter and spells every digit; ranges like «10-15» keep their existing behaviour.

### D14. Routing for native-script `ja`/`hi`, and the hint (T2-10)
`resolveSayVoice` in the CLI, which sees the text, routes `ja`/`hi` text in its native script to an installed AVSpeech voice for that language when one exists (`ja-JP` prefers `Otoya`, `hi-IN` prefers `Rishi`, both male; falls back to the first installed voice for that locale), the same shape as the darwin `ru` route; romanized text keeps routing to the Kokoro voice. When no such voice is installed the engine's `E_SCRIPT_UNSUPPORTED` hint names the `macos-*` voices from `--list-voices` that carry the language. The routing table keeps an entry per language (#769: a missing entry silently drops `--voice`).

### D15. `--no-expand-abbrev` warning (T3-14)
The code writes the warning and the CLI prints warn events on success, so the row is reproduced against a `main` build first. If it reproduces, the layer that drops the event is fixed and an integration test pins the line for `--voice en-am_michael --no-expand-abbrev`; if it does not, the row is recorded as a v1.25.0-only observation and the test is still added.

### D16. Diagnostics agree with the synthesis path (T2-6, T2-7, T2-8)
`kesha status` reports voices from `listVoiceIds()` (the engine's `--list-voices` union) when the engine is installed and falls back to the filesystem scan only when it is not; the spawn is bounded by the existing engine timeout and `status` stays free of disk scanning. `src/kokoro-ane.ts` reports `languagesStaged` derived from the voice packs present and `doctor --json` carries the TTS voice and language lists; a Kokoro language whose pack is absent is listed under `missing` for that language rather than the component claiming completeness. `src/install-plan.ts` emits sized components for the FluidAudio ANE sets on darwin-arm64, sizes generated from `rust/src/models/manifest.rs` (the `check:model-plan-sizes` gate keeps them honest), so `install --plan --tts es` states the bytes it will fetch.

### D17. `install --tts <unknown>` (T2-11)
`src/cli/install.ts` renders the unsupported-language error through `renderInvalidArg` and exits 2, matching its sibling catch.

### D18. Documents (T2-1, T2-9, T3-1)
`docs/diagnostic-logs.md` drops "FluidAudio bundles" from the Model-cache row and states the exception the state-directories spec already carries. The "Default voices are male" requirement names both documented exceptions (French, and darwin Russian to AVSpeech Milena as the zero-install route). `docs/tts.md` L187 stops claiming darwin FluidAudio Kokoro rejects `--ssml`, the `<prosody rate>` row includes darwin `en-*`, and the `<phoneme>` row says the wrapped text is read on darwin. `docs/errors.md` gains the reclassified rows.

## Risks / Trade-offs

- **Refusing dominant-script mismatches changes behaviour for inputs that produced audio before** (Cyrillic on an English voice, T2-12). That audio was filler; the refusal names an installed voice that can speak it. Mixed sentences keep producing audio, with a warning.
- **Chunking on the FluidAudio path introduces seams in long English text.** The ONNX path has used the same seam module since #479; the e2e duration and round-trip tests cover the join.
- **`status` spawning the engine** costs one describe plus `--list-voices` (with the AVSpeech sidecar on darwin). It is bounded by the engine timeout and only runs when an engine is installed; the fallback keeps `status` useful without one.
- **The sidecar exit-status contract** (2 = voice not found) couples Swift and Rust; a test drives the fake helper with exit 2 and the real helper's message is pinned by the smoke test on darwin.
- **English number verbalization is new surface** and will disagree with a human on some inputs (ordinals, years). The scope is currency and comma-grouped integers; years and bare integers stay with the G2P, which handles them today (`Room 405`, `1999` round-trip correctly).
- **Exit codes change** for seven FluidAudio languages (`E_MODEL_MISSING` 4 to 1) and for `E_VOICE_UNKNOWN` on the AVSpeech path; scripts keyed on the coded line are unaffected, which `docs/errors.md` already recommends.
