# Language Detection Specification

## Purpose

Language detection answers the question "what language is this?" for both
audio files and plain text. Ira uses it in pipelines to route transcripts by
language. Sona uses the JSON output fields to tag structured results. Maks
gets a `[lang: ru, confidence: 1.00]` trailer on `--format transcript` output
without thinking about it.

Two independent sub-capabilities exist:

- **Language detection (audio)** — ECAPA-TDNN VoxLingua107 ONNX model;
  analyzes only the first 10 s of audio; returns `{code, confidence}`.
- **Language detection (text)** — macOS `NLLanguageRecognizer` via the
  `kesha-textlang` Sidecar (or legacy `swift -e` fallback); returns
  `{code, confidence}`; macOS only.

Both sub-capabilities are also called automatically during transcription when
structured output is requested (see the transcription spec for how results
surface in JSON/TOON/transcript-format output).

## Non-Goals

- Language detection (text) is not available on Linux or Windows; those
  platforms return an error.
- The audio model analyzes only the first 10 s; it does not summarize language
  across a full recording.
- Language detection does not translate or re-transcribe in a different
  language; it only identifies.
- The CLI-side `tinyld` text fallback is a best-effort safety net when the
  Engine text-lang call fails; it carries confidence 0 and is not a
  first-class output.

## Requirements

### Requirement: Audio language detection returns a language code and confidence

The Engine's `detect-lang` subcommand SHALL accept one audio file path, run
the ECAPA-TDNN VoxLingua107 model on the first 10 s of audio, and print a
single-line JSON object `{"code":"<BCP-47-ish>","confidence":<float>}` to
stdout. Progress and errors go to stderr.

#### Scenario: Ira identifies the language of a call recording

- GIVEN the Lang-ID model is installed and `call.ogg` contains Russian speech
- WHEN Ira runs `kesha-engine detect-lang call.ogg`
- THEN stdout is `{"code":"ru","confidence":0.97}` (exact value varies)
- AND the process exits 0

#### Scenario: Audio file does not exist

- WHEN Ira runs `kesha-engine detect-lang missing.ogg`
- THEN an error naming the missing file is printed to stderr
- AND the process exits 1
- AND the error fires before the model is consulted (input validation first)

#### Scenario: Lang-ID model not installed

- GIVEN the Lang-ID model is absent from the Model cache
- WHEN Ira runs `kesha-engine detect-lang call.ogg` on a valid audio file
- THEN the Engine reports `E_MODEL_MISSING` and suggests `kesha install`
- AND the process exits 1

> *Technical Note — model: ECAPA-TDNN VoxLingua107, 107 languages, first-10-s
> window. Source: `rust/src/lang_id.rs` lines 14 (`MAX_SECONDS = 10.0`) and 43
> (`load_audio_truncated`). ONNX input: `"waveform"` `[1, samples]` float32;
> output: `"language_probs"` `[1, 107]` float32. Error code: `E_MODEL_MISSING`
> from `rust/src/errors.rs`. CLI dispatch: `rust/src/cli/detect_lang.rs`.*

### Requirement: Audio language detection is skipped for long transcripts

During transcription, the CLI SHALL skip the audio Language detection (audio)
call and log a diagnostic when the estimated transcript duration exceeds
10 minutes (600 s). The transcription itself still completes; the language
fields in the output are populated from the text-language result or the
`tinyld` fallback instead.

#### Scenario: Ira transcribes a 90-minute lecture with --json

- GIVEN a 90-minute audio file
- WHEN Ira runs `kesha --json lecture.mp3`
- THEN the Engine audio lang-id call is skipped
- AND a `skip lang_id_audio` diagnostic is emitted to stderr naming the
  threshold
- AND the JSON result still includes a `lang` field (populated from text-lang
  or `tinyld`)
- AND the process exits 0

#### Scenario: Short recording triggers audio lang-id normally

- GIVEN a 3-minute voice note
- WHEN Maks runs `kesha --json note.ogg`
- THEN the audio lang-id call runs and the result populates the `lang` field

> *Technical Note — threshold: `AUDIO_LANG_ID_LONG_AUDIO_THRESHOLD_SECONDS =
> 10 * 60` (600 s). Guard function: `shouldRunAudioLanguageDetection` in
> `src/cli/main.ts` lines 139–145. Audio lang-id is triggered when any of
> `--lang`, `--verbose`, `--json`, `--toon`, or `--format transcript` is
> active (`wantsLangId`, `src/cli/main.ts` line 322).*

### Requirement: Text language detection returns a language code and confidence on macOS

The Engine's `detect-text-lang` subcommand SHALL accept a text argument, pass
it to the `kesha-textlang` Sidecar (or the legacy `swift -e` path when the
sidecar is absent), and print `{"code":"<code>","confidence":<float>}` to
stdout. The subcommand SHALL fail with an error on non-macOS platforms. It
SHALL fail with an error when the text is empty or whitespace-only.

#### Scenario: Sona identifies the language of a transcript fragment

- GIVEN the engine runs on macOS
- WHEN Sona runs `kesha-engine detect-text-lang "Привет, как дела?"`
- THEN stdout is `{"code":"ru","confidence":0.99}` (value varies)
- AND the process exits 0

#### Scenario: Empty text is rejected

- WHEN Ira runs `kesha-engine detect-text-lang "   "`
- THEN an error `detect-text-lang requires non-empty text` is printed to stderr
- AND the process exits 1

#### Scenario: Non-macOS platform

- GIVEN `kesha-engine` is the Linux ONNX build
- WHEN Ira runs `kesha-engine detect-text-lang "hello"`
- THEN the Engine reports that `detect-text-lang` is only available on macOS
- AND the process exits 1

> *Technical Note — empty-text guard: `rust/src/cli/detect_text_lang.rs`
> lines 6–8. Non-macOS error: `rust/src/text_lang.rs` lines 131–133. Sidecar
> path (`system_text_lang` feature): `rust/src/text_lang.rs` lines 31–51;
> resolves `kesha-textlang` sibling-of-exe first, then build-time `OUT_DIR`
> fallback. Legacy `swift -e` path (no feature): `rust/src/text_lang.rs`
> lines 104–127.*

### Requirement: Language detection results surface in transcription output

The CLI SHALL populate language fields in transcription output whenever any of
`--lang`, `--verbose`, `--json`, `--toon`, or `--format transcript` is active
(the `wantsLangId` condition):

- `--format transcript` appends `[lang: <code>, confidence: <n>]` to the
  transcript text.
- `--json` / `--toon` include `lang`, and language detection sub-fields in
  each result object.
- When the Engine text-lang call succeeds, its result is used; when it fails
  or is unavailable, the CLI-side `tinyld` result is used as a fallback with
  `confidence: 0`.

#### Scenario: Maks checks language on a voice note

- WHEN Maks runs `kesha --format transcript note.ogg`
- THEN the output ends with a `[lang: ru, confidence: 1.00]` trailer
- AND no error is printed to stderr

#### Scenario: Sona reads language fields from JSON

- WHEN Sona runs `kesha --json call.ogg`
- THEN the result object includes a `lang` string field and the process exits 0

#### Scenario: --lang mismatch triggers a warning, not a failure

- GIVEN `ru.ogg` contains Russian speech detected with confidence above 0.8
- WHEN Ira runs `kesha --lang en ru.ogg`
- THEN the transcript is still printed and the process exits 0
- AND stderr carries a language-mismatch warning

> *Technical Note — `wantsLangId` trigger: `src/cli/main.ts` line 322.
> `tinyld` fallback: `detect` imported from `tinyld` package, used at
> `src/cli/main.ts` line 397. Text-lang engine call: `detectTextLanguageEngine`
> called at line 401. `tinyld` result carries `confidence: 0` to signal it is
> the fallback (`src/cli/main.ts` line 420).*

## Open Issues

- The 10 s audio window means accent-switched recordings (language changes
  after the first 10 s) may be mis-identified. No plan to extend the window
  today.
- Audio lang-id is unconditionally skipped for transcripts over 10 minutes;
  a more precise duration-based gate (based on actual audio duration rather
  than estimated transcript duration) is a possible future improvement.
- `tinyld` confidence is always reported as 0, making it indistinguishable
  from a genuine 0-confidence Engine result in the JSON output.
