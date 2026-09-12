## MODIFIED Requirements

### Requirement: Text normalization expands acronyms and numbers per language

Normalization SHALL run before G2P. English: uppercase tokens of 2–5
characters are letter-spelled unless they appear on the English stop-list or in
the IPA lexicon (which supplies a fixed pronunciation). Russian (`ru-vosk-*`):
all-caps Cyrillic tokens of 2–5 letters are letter-spelled when they fail the
pronounceability heuristic (strict consonant-vowel alternation reads as a word)
and are not on the Russian stop-list. Spanish/French/Italian/Portuguese:
integers 0–999,999 are expanded to words and 2–5-character uppercase acronyms
are letter-spelled with that language's letter names, with per-language
stop-lists exempting word-acronyms. `--no-expand-abbrev` SHALL disable the
automatic letter-spelling for Russian and for English on ONNX Kokoro builds —
but the English IPA lexicon still fires, and `<say-as interpret-as="characters">`
still works. On every other path — FluidAudio Kokoro, `macos-*` AVSpeech, and
the Romance normalizer that runs inside CharsiuG2P — expansion belongs to an
engine that offers no suppression knob, and the Engine SHALL emit a `warn`
event on the Event stream rather than accept the flag silently.

#### Scenario: English initialism is letter-spelled, lexicon word is not

- WHEN Ira runs `kesha say "Parse the JSON with the IBM SDK"`
- THEN `JSON` is pronounced "jason" (IPA lexicon hit)
- AND `IBM` is spelled letter by letter
- AND `SDK` is spelled letter by letter

#### Scenario: Stop-listed word-acronym reads as a word

- WHEN Maks runs `kesha say "NASA launched it"`
- THEN `NASA` is read as a word, not "en a es a"

#### Scenario: Russian initialism vs pronounceable acronym

- WHEN Maks runs `kesha say --voice ru-vosk-m02 "ФСБ и ВОЗ"`
- THEN `ФСБ` is expanded to "эф эс бэ" (no vowels — fails the
  pronounceability heuristic)
- AND `ВОЗ` is read as a word (strict consonant-vowel alternation)

#### Scenario: Spanish numbers and acronyms

- WHEN Ira runs `kesha say --voice es-em_alex "El DNI cuesta 12 euros, dice la OTAN"`
- THEN `12` is expanded to "doce", `DNI` is spelled "de ene i"
- AND `OTAN` (stop-listed) is read as a word

#### Scenario: --no-expand-abbrev disables spelling but not the lexicon

- WHEN Sona runs `kesha say --no-expand-abbrev "EPAM hired IBM"`
- THEN `IBM` passes through unspelled
- AND `EPAM` still uses its IPA lexicon pronunciation

#### Scenario: --no-expand-abbrev on an engine that cannot honor it warns

- GIVEN the released darwin-arm64 build, whose `en-*` voices run on FluidAudio
- WHEN Sona runs `kesha say --voice en-am_michael --no-expand-abbrev "IBM"`
- THEN `IBM` is still spelled letter by letter, because the initialism rule
  lives inside FluidAudio's G2P
- AND the Engine emits a `warn` event naming where the flag does apply, which
  the CLI renders on stderr

#### Scenario: --no-expand-abbrev on an old engine warns instead of lying

- GIVEN an Engine whose describe document lists neither `tts.ru_acronym_expansion`
  nor `tts.en_acronym_expansion` in `features`
- WHEN Ira passes `--no-expand-abbrev`
- THEN the CLI rejects the flag against the schema before spawning the Engine
  and names upgrading the Engine as the action — never a silent drop

> *Technical Note — English: 30-entry stop-list (OK/NO/GO/…/NASA/NATO/AIDS/
> OPEC/IKEA/ASCII/NAFTA/LASER/RADAR/SCUBA) and IPA lexicon (EPAM, JSON, JPEG,
> GIF, SQL, ASAP, CRUD, JWT, OAuth, Microsoft, Anthropic, Claude, Kubernetes,
> PostgreSQL, GraphQL, Linux, Tokio, macOS, Granola) in
> `rust/src/tts/en/acronym.rs:23-59`; the lexicon fires even with
> `--no-expand-abbrev` (`:121-125`, test `ipa_fires_even_without_auto_expand`).
> Russian: rules and 25-entry stop-list (ВСЁ, ВЫ, ДА, …, ЧТО) in
> `rust/src/tts/ru/acronym.rs:1-66`; tokens must be 2–5 chars of `[А-ЯЁ]`
> without Ъ/Ь, and spell only when length ≤ 2 or an adjacent same-type letter
> pair exists. Romance languages: numbers 0–999,999
> (`rust/src/tts/normalize/numbers.rs`), letter tables and stop-lists
> `ES_STOP_LIST` = OTAN, OVNI, SIDA, OPEP, OEA, ONU, FIFA, OMS;
> `FR_STOP_LIST` = OTAN, OVNI, SIDA, FIFA, OPEP, ONU, OMS;
> `IT_STOP_LIST` = FIAT, NATO, FIFA, AIDS, ONU;
> `PT_STOP_LIST` = OTAN, OVNI, SIDA, AIDS, FIFA, ONU, OMS
> (`rust/src/tts/normalize/acronyms.rs:141-145`) — curated seeds, not
> exhaustive. Six-plus-character all-caps words (UNESCO) pass through
> untouched. The hand-written capability gate of `--no-expand-abbrev` at
> `src/synth.ts:69-85` is replaced by the generic `validateArgv` in
> `src/engine/describe.ts`.*

### Requirement: Exit codes distinguish failure classes

`kesha say` SHALL exit 0 on success, 1 when voice resolution rejects the
request, 2 for invalid input (bad flags, empty text, malformed flag
combinations), 4 for synthesis-time failures, and 5 when the text exceeds the
length limit. The CLI SHALL propagate the Engine's exit code unchanged
(`KeshaError.exitCode`); CLI-side pre-checks use the same map.

Exit 1 SHALL cover the checks that run while the Voice id is resolved: an
unknown voice, and a model absent from the Model cache on the paths the cache
gates (ONNX Kokoro, Vosk). Exit 4 SHALL cover every coded failure raised once
resolution has succeeded, including the darwin-arm64 FluidAudio asset
pre-check, which reports `E_MODEL_MISSING` from synthesis rather than from
resolution. The Error code says what went wrong and the exit code says how far
the run got, so the same `E_MODEL_MISSING` legitimately appears with either.

#### Scenario: Exit-code contract in a script

- GIVEN a shell script that branches on `$?`
- WHEN it runs `kesha say "hi"` / `--voice xx-none "hi"` / `--rate 9 "hi"` /
  `--ssml "no-root"` / a 6000-character input
- THEN it observes exit codes 0, 1, 2, 4, and 5 respectively

#### Scenario: Unexpected internal error maps to 4

- WHEN the Engine subprocess dies without emitting an `error` event
- THEN the CLI reports the captured stderr and exits with the Engine's nonzero
  code, or 4 when no `KeshaError` carried one

> *Technical Note — Engine map: `rust/src/cli/say.rs::exit_code_for_tts_err`
> (`EmptyText` → 2, `TextTooLong` → 5, `SynthesisFailed`/`Coded` → 4). Voice
> resolution failures return 1 from `cli/say.rs::resolve_voice`, which is where
> the `ModelMissing` bails in `tts/voices.rs::build_kokoro_voice` (ONNX Kokoro)
> and `::resolve_vosk_ru` surface; `--model`/`--voice-file` and output-format
> errors return 2 from `resolve_voice` and `cli/say.rs::run`.
> `E_SSML_INVALID`, `E_SSML_UNSUPPORTED`, `E_SCRIPT_UNSUPPORTED`, and the
> darwin-arm64 late `E_MODEL_MISSING` from `models::missing_kokoro_assets` all
> reach the caller as `TtsError::Coded` → exit 4. CLI side: `KeshaError`
> (`src/engine/events.ts`) carries the Engine exit code exactly as `SayError`
> did (`src/synth.ts:103-113`), and `src/synth.ts::say` pre-checks empty text
> (2) and the length limit (5).*
