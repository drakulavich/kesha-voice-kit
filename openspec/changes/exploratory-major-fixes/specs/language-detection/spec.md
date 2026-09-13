## MODIFIED Requirements

### Requirement: Language detection results surface in transcription output

The CLI SHALL populate language fields in transcription output whenever any of
`--lang`, `--verbose`, `--json`, `--toon`, or `--format transcript` is active
(the `wantsLangId` condition):

- `--format transcript` appends `[lang: <code>, confidence: <n>]` to the
  transcript text.
- `--json` / `--toon` include `lang`, and language detection sub-fields in
  each result object.
- When the Engine text-lang call succeeds, its result is used; when it fails
  or is unavailable — which is every non-macOS platform — the CLI-side
  `tinyld` result is used as a fallback.
- `textLanguage` SHALL carry a `source` field naming the detector behind it:
  `"engine"` or `"tinyld"`. Each detector reports its own score in
  `confidence`; the scores are on different scales (`NLLanguageRecognizer`'s
  probability vs `tinyld`'s n-gram accuracy) and SHALL NOT be compared across
  sources. `audioLanguage` has one source and carries no such field.
- The top-level `lang` SHALL NOT be named by a `tinyld` guess whose
  confidence is below 0.5; the guess stays in `textLanguage` unchanged, and
  `--verbose` marks it "below the 0.5 floor, ignored for lang". An Engine
  text result is not floored: its probability is on another scale.
- The `--lang` comparison SHALL be case-insensitive and SHALL compare only the
  primary language subtag, treating `_` as `-`: `en-US`, `EN` and `en_us` all
  match a detected `en`. Codes are ISO 639-1; a three-letter code such as
  `eng` is not recognised and warns like any other mismatch. The warning
  quotes the code as the user typed it.

#### Scenario: Maks checks language on a voice note

- WHEN Maks runs `kesha --format transcript note.ogg`
- THEN the output ends with a `[lang: ru, confidence: 1.00]` trailer
- AND no error is printed to stderr

#### Scenario: Sona reads language fields from JSON

- WHEN Sona runs `kesha --json call.ogg`
- THEN the result object includes a `lang` string field and the process exits 0

#### Scenario: Sona tells a fallback detection from an unsure one

- GIVEN Sona runs on Linux, where the Engine has no text detection
- WHEN Sona runs `kesha --json call.ogg`
- THEN `textLanguage.source` is `"tinyld"` and `textLanguage.confidence` is
  `tinyld`'s own score, not a placeholder `0`
- AND the same command on macOS reports `textLanguage.source` `"engine"`, so a
  genuinely unsure Engine detection is distinguishable from a fallback one

#### Scenario: --lang mismatch triggers a warning, not a failure

- GIVEN `ru.ogg` contains Russian speech detected with confidence above 0.8
- WHEN Ira runs `kesha --lang en ru.ogg`
- THEN the transcript is still printed and the process exits 0
- AND stderr carries a language-mismatch warning

#### Scenario: A weak tinyld guess does not name the language

- GIVEN Sona runs on Linux and `hi.ogg` transcribes to two words that
  `tinyld` scores `ber` at 0.33
- WHEN Sona runs `kesha --json --verbose hi.ogg`
- THEN `lang` is `""` while `textLanguage` still reports `ber` at 0.33 from
  `tinyld`
- AND stderr's `Text language` line says the guess was below the 0.5 floor
  and ignored for lang

#### Scenario: A regional --lang matches its primary language

- GIVEN `note.ogg` contains English speech
- WHEN Ira runs `kesha --lang en-US note.ogg` (or `--lang EN`, or `--lang en_us`)
- THEN no language-mismatch warning is printed
- AND the process exits 0

> *Technical Note — `wantsLangId` trigger: `src/cli/main.ts`. `tinyld`
> fallback: `detectTextLanguageFallback` in `src/cli/main.ts`, reading the top
> `detectAll` entry's `accuracy` and tagging it `source: "tinyld"`. Text-lang
> engine call: `detectTextLanguageEngine`, tagged `source: "engine"` at the
> call site. Shape: `TextLangDetectResult` in `src/types.ts` (#941). `--lang`
> matching: `primaryLanguageSubtag` and `checkLanguageMismatch` in
> `src/cli/main.ts`. Floor: `LANG_CONFIDENCE_FLOOR` and `routeLanguage` in
> `src/language-routing.ts`.*
