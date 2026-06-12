# TTS Synthesis Specification

## Purpose

`kesha say` turns text into speech, entirely locally. Maks pipes Russian and
English replies into Telegram voice notes; Ira scripts batch narration in CI;
Sona calls the same path through the `say()` Core API and the MCP server. The
CLI resolves a Voice id, spawns the Engine, and streams audio bytes to stdout
(or `--out`), keeping stderr for progress and errors. Three TTS engines sit
behind one flag surface: Kokoro (Kokoro-82M, 24 kHz), Vosk (Vosk-TTS Russian,
22.05 kHz, multi-speaker), and AVSpeech (macOS system voices via the
`say-avspeech` Sidecar).

## Non-Goals

- TTS never downloads the Engine or models (Never-auto-download rule); missing
  models fail with a `kesha install --tts` hint.
- No streaming synthesis — output is a finished audio file or byte buffer
  (`--stdin-loop` is an internal Engine mode, not a public contract).
- No voice cloning or custom voice training.
- Hindi and Japanese native-script synthesis are explicitly out of scope today
  (see Script gates below and Open Issues).
- Audio playback — `kesha say` produces bytes; playing them is the caller's job.

## Requirements

### Requirement: Synthesize text to speech with pipe-friendly output

The CLI SHALL synthesize the given text (positional argument, or stdin when the
positional is omitted) and write the audio bytes to stdout, unless `--out
<path>` is given, in which case the audio is written to that file and stdout
stays empty. All progress and error output SHALL go to stderr. Missing text
SHALL be rejected before synthesis: no positional argument with a TTY stdin
exits 2, and empty (or whitespace-only) text exits 2 with `E_TEXT_EMPTY`. Text
longer than 5000 Unicode characters SHALL be rejected with `E_TEXT_TOO_LONG`
and exit code 5, before any model is loaded.

#### Scenario: Maks pipes a voice note to a file

- GIVEN the Engine and English TTS models are installed
- WHEN Maks runs `kesha say "Hello from Kesha" > hello.wav`
- THEN `hello.wav` contains a playable WAV file
- AND nothing but audio bytes went to stdout
- AND the process exits 0

#### Scenario: Ira pipes text via stdin in CI

- WHEN Ira runs `echo "Build passed" | kesha say --out status.wav`
- THEN the text is read from stdin and synthesized into `status.wav`
- AND the `Synthesizing default voice -> status.wav...` progress line (voice
  label or `default voice`) goes to stderr
- AND the process exits 0

#### Scenario: No text and interactive stdin

- WHEN Maks runs `kesha say` in a terminal with no piped input
- THEN stderr explains that text or piped stdin is required
- AND the process exits 2 without spawning the Engine

#### Scenario: Text over the 5000-character limit

- WHEN Sona calls `say()` with a 5001-character string
- THEN the call fails with Error code `E_TEXT_TOO_LONG` naming the limit and
  the actual length
- AND the Exit code is 5 (CLI path) — distinct from generic invalid input

#### Scenario: Empty text after trimming

- WHEN Ira runs `printf '   ' | kesha say`
- THEN the run fails with `E_TEXT_EMPTY` and exits 2

> *Technical Note — the limit is `MAX_TEXT_CHARS = 5000`, counted in Unicode
> code points (`Array.from(text).length` / `chars().count()`), enforced in both
> the CLI (`src/synth.ts:22,117-125`) and the Engine
> (`rust/src/tts/mod.rs:41`). TTY guard: `src/cli/say.ts:54-59`
> (`shouldRejectMissingSayText`). Stdin is trimmed before the empty check
> (`src/cli/say.ts:38-52`, `rust/src/cli/say.rs:185-201`).*

### Requirement: Voice routing resolves --voice, then --lang, then detected language, then the engine default

Voice routing SHALL apply this precedence: an explicit `--voice` wins
unconditionally; otherwise `--lang` maps the stated language to its default
voice via `pickVoiceForLang` without running text-language detection;
otherwise Language detection (text) runs and its result (when confidence is at
least 0.5) is mapped the same way; otherwise the voice is left unset and the
Engine uses its Default voice, `en-am_michael`. A `--lang` value with no
mapped voice SHALL resolve to the engine default rather than re-running
detection. The Voice id scheme is `<lang>-<name>`; the `<lang>` prefix routes
to a TTS engine (Kokoro, Vosk, or AVSpeech), and an unparseable or unsupported
Voice id SHALL fail with `E_VOICE_UNKNOWN` and exit 1.

#### Scenario: Explicit voice beats explicit language

- WHEN Maks runs `kesha say --voice ru-vosk-f01 --lang en "привет"`
- THEN synthesis uses `ru-vosk-f01` (the `--voice` wins)
- AND `--lang` is still forwarded to the Engine as the G2P language override

#### Scenario: --lang skips detection on Linux

- GIVEN Ira's Linux runner, where macOS text-language detection is unavailable
- WHEN Ira runs `kesha say --lang ru "Сборка прошла успешно"`
- THEN the voice resolves to `ru-vosk-m02` without any detection call
- AND the process exits 0

#### Scenario: Auto-detection routes Russian to AVSpeech on macOS

- GIVEN Maks's Mac with no `--voice` or `--lang` given
- WHEN Maks runs `kesha say "Привет, это Кеша"`
- THEN text-language detection identifies `ru`
- AND the voice resolves to `macos-com.apple.voice.compact.ru-RU.Milena`
  (zero-install AVSpeech path; `--voice ru-vosk-m02` opts into Vosk quality)

#### Scenario: Low-confidence detection falls back to the engine default

- WHEN Sona synthesizes a short ambiguous string detected with confidence 0.3
- THEN `pickVoiceForLang` returns no voice
- AND the Engine synthesizes with its Default voice `en-am_michael`

#### Scenario: Unknown voice id

- WHEN Ira runs `kesha say --voice gibberish "test"`
- THEN the Engine reports that a Voice id must be in `lang-name` form, with
  Error code `E_VOICE_UNKNOWN`
- AND the process exits 1

#### Scenario: Unsupported voice language

- WHEN Maks runs `kesha say --voice de-something "Hallo"`
- THEN the run fails with `E_VOICE_UNKNOWN` listing the supported prefixes
- AND the process exits 1

> *Technical Note — precedence: `src/cli/say.ts:27-35` (`resolveSayVoice`);
> mapping: `src/voice-routing.ts:31-53` (`pickVoiceForLang`). The full map
> (confidence < 0.5 → none; base code is lowercased and split on `-`/`_`):*
>
> | Detected/stated lang | darwin (any arch) | darwin-arm64 extra | Linux/Windows/Intel macOS |
> |---|---|---|---|
> | `en` | `en-am_michael` | — | `en-am_michael` |
> | `ru` | `macos-com.apple.voice.compact.ru-RU.Milena` | — | `ru-vosk-m02` |
> | `es` | — | `es-em_alex` | `es-em_alex` |
> | `fr` | — | *(unmapped → engine default)* | `fr-ff_siwis` |
> | `hi` | — | `hi-hm_omega` | *(unmapped)* |
> | `it` | — | `it-im_nicola` | `it-im_nicola` |
> | `ja` | — | `ja-jm_kumo` | *(unmapped)* |
> | `pt` | — | `pt-pm_alex` | `pt-pm_alex` |
> | `zh` | — | `zh-zm_yunjian` (see Open Issues — engine ships `zh-zm_050`) | *(unmapped)* |
>
> *Engine-side routing (`rust/src/tts/voices.rs:99-148`): `en-*` → Kokoro;
> `es/fr/hi/it/ja/pt/zh-*` → FluidAudio Kokoro on the darwin-arm64
> `system_kokoro` build, `es/fr/it/pt-*` → ONNX Kokoro elsewhere; `ru-*` →
> Vosk (the `vosk-` infix is optional; speakers map `f01→0, f02→1, f03→2,
> m01→3, m02→4`, `rust/src/tts/voices.rs:295-300`); `macos-*` → AVSpeech
> (suffix forwarded as identifier or language code; empty suffix rejected).
> Engine default: `DEFAULT_VOICE_ID = "en-am_michael"`
> (`rust/src/tts/voices.rs:45`).*

### Requirement: Default voices are male

Every Default voice SHALL be male — Kesha is a male brand voice. The English
default is `en-am_michael`; the Russian Vosk default is `ru-vosk-m02`; Spanish,
Italian, and Portuguese default to `es-em_alex`, `it-im_nicola`, and
`pt-pm_alex`. The single documented exception is French: Kokoro v1.0 ships no
male French voice, so `fr` defaults to `fr-ff_siwis` (female) until a male
French voice exists.

#### Scenario: Default English voice is male

- WHEN Maks runs `kesha say "Good morning"` with no voice flags and English
  detected
- THEN synthesis uses `en-am_michael` (American male)

#### Scenario: French falls back to the documented female exception

- WHEN Ira runs `kesha say --voice fr- "Bonjour"` on a Linux runner
- THEN the Engine resolves the empty name to the language default `ff_siwis`
- AND this is the documented brand-rule exception, not a regression

> *Technical Note — per-language defaults: `rust/src/tts/voices.rs:221-233`
> (`default_voice_for_lang`), with the brand-rule exception comment inline.
> Female Vosk voices `ru-vosk-f01/f02/f03` stay selectable via explicit
> `--voice`.*

### Requirement: TTS models are never auto-downloaded

Synthesis SHALL fail loudly — never download — when the required TTS model is
not in the Model cache. The failure carries Error code `E_MODEL_MISSING` and an
actionable `kesha install --tts` hint, and exits 1.

#### Scenario: Synthesis with installed models stays offline

- GIVEN the English Kokoro model is installed
- WHEN Ira runs `kesha say "ready" --out ready.wav` on an air-gapped runner
- THEN synthesis succeeds with no network access

#### Scenario: Missing Russian model

- GIVEN the Vosk Russian model is not installed
- WHEN Maks runs `kesha say --voice ru-vosk-m02 "привет"`
- THEN stderr reads `voice 'ru-vosk-m02' not installed. run: kesha install --tts`
  with Error code `E_MODEL_MISSING`
- AND the process exits 1 without downloading anything

> *Technical Note — model presence gates: `rust/src/tts/voices.rs:192-204`
> (ONNX Kokoro), `:307-313` (Vosk). `macos-*` voices need no model download;
> FluidAudio Kokoro voices are fetched only by `kesha install --tts`.*

### Requirement: Output formats — wav, ogg-opus, flac

The CLI SHALL produce one of three Output formats (TTS): **wav** (default;
IEEE-float mono at the engine's native sample rate), **ogg-opus** (mono Opus in
an OGG container; `--bitrate` 6000–510000 bps, default 32000; `--sample-rate`
one of 8000/12000/16000/24000/48000 Hz, default 24000), and **flac** (lossless
16-bit, native rate, no encoder knobs). When `--format` is omitted the format
SHALL be inferred from the `--out` extension (`.wav` → wav; `.ogg`/`.opus`/
`.oga` → ogg-opus; `.flac` → flac; anything else → wav). `opus` and `ogg`
SHALL be accepted as aliases for `ogg-opus`. An unknown `--format` value exits
2, and `--bitrate`/`--sample-rate` with any non-opus format also exit 2.

#### Scenario: Maks makes a Telegram-ready voice note

- WHEN Maks runs `kesha say --format ogg-opus "Уже еду" --out note.ogg`
- THEN `note.ogg` is a mono OGG/Opus file at 24 kHz, 32 kbps
- AND Telegram renders it as a native voice message

#### Scenario: Format inferred from the --out extension

- WHEN Ira runs `kesha say "done" --out done.opus`
- THEN the output is ogg-opus without any `--format` flag

#### Scenario: Alias accepted

- WHEN Sona passes `--format opus`
- THEN it is treated exactly as `--format ogg-opus`

#### Scenario: Unknown format

- WHEN Ira runs `kesha say --format mp3 "test"`
- THEN stderr lists the supported formats (wav, ogg-opus, flac)
- AND the process exits 2 without spawning the Engine

#### Scenario: Opus knobs rejected for WAV

- WHEN Maks runs `kesha say --bitrate 64000 "test" --out test.wav`
- THEN stderr explains `--bitrate` and `--sample-rate` are only valid with
  `--format ogg-opus`
- AND the process exits 2

#### Scenario: Bitrate out of the Opus range

- WHEN Ira runs `kesha say --format ogg-opus --bitrate 1000 "test"`
- THEN the Engine rejects it (`--bitrate must be 6000..=510000 bps`)
- AND the run fails rather than producing degraded audio

> *Technical Note — format parsing and aliases: `rust/src/tts/encode.rs:82-94`
> (`FromStr`) mirrored in `src/cli/say.ts:169-180`; extension inference:
> `rust/src/tts/encode.rs:98-105`, resolution order (`--format` > `--out`
> extension > wav default): `rust/src/cli/say.rs:36-82`. Opus constraints:
> `OPUS_VALID_SR = {8000, 12000, 16000, 24000, 48000}`
> (`rust/src/tts/encode.rs:184`), bitrate `6000..=510000`
> (`rust/src/tts/encode.rs:218`), defaults 32000 bps / 24000 Hz
> (`ogg_opus_default`, `rust/src/tts/encode.rs:69-75`). Native rates: Kokoro
> 24 kHz, Vosk 22.05 kHz (resampled for Opus, kept as-is for wav/flac). FLAC
> quantizes f32 to 16-bit PCM (`rust/src/tts/encode.rs:138-144`). The CLI
> pre-validates knob/format combinations (`src/cli/say.ts:186-200`); the
> Engine repeats the check authoritatively.*

### Requirement: Speaking rate is bounded

The CLI SHALL accept `--rate` between 0.5 and 2.0 inclusive (default 1.0) and
exit 2 for values outside that range or non-numeric values.

#### Scenario: Slower narration

- WHEN Maks runs `kesha say --rate 0.8 "Read this slowly"`
- THEN synthesis runs at 0.8× speed and exits 0

#### Scenario: Rate out of range

- WHEN Ira runs `kesha say --rate 3.0 "test"`
- THEN stderr reads `--rate must be between 0.5 and 2.0.`
- AND the process exits 2

#### Scenario: Non-numeric rate

- WHEN Ira runs `kesha say --rate fast "test"`
- THEN stderr reads `--rate must be a finite number.`
- AND the process exits 2

> *Technical Note — validation: `src/cli/say.ts:72-80`. The CLI omits `--rate`
> from the Engine argv when it equals 1.0 (`src/synth.ts:71`). An SSML
> whole-utterance `<prosody rate>` multiplies with `--rate`; the product is
> clamped to 0.5–2.0 (`rust/src/tts/ssml/rate.rs`). `--rate` is silently
> ignored for `macos-*` AVSpeech voices — see Open Issues.*

### Requirement: SSML subset with strict root and graceful tag degradation

With `--ssml`, the input SHALL be parsed as SSML and SHALL start with a
`<speak>` root element; anything else fails with `E_SSML_INVALID` (exit 4).
Supported tags: `<break time="...">` (silence, default 250 ms, capped at 30 s),
`<say-as interpret-as="characters">` (letter-by-letter spelling), `<phoneme
alphabet="ipa" ph="...">` (bypasses G2P; `alphabet` defaults to ipa),
`<emphasis>` (stress hint; `level="none"` strips `+` stress markers), and
`<prosody rate="...">` when it wraps the entire utterance. Unknown tags SHALL
emit one stderr warning per tag name and be stripped with their text content
preserved. `<!DOCTYPE>` anywhere in the document SHALL be rejected
(`E_SSML_INVALID`), as SHALL relative-percent prosody rates (`+25%`/`-25%`).
AVSpeech (`macos-*`) voices SHALL reject `--ssml` entirely with
`E_SSML_UNSUPPORTED`.

#### Scenario: Maks adds a pause and a phoneme override

- WHEN Maks runs
  `kesha say --ssml '<speak>Kesha <break time="500ms"/> <phoneme alphabet="ipa" ph="ˈkeʃa">Kesha</phoneme></speak>'`
- THEN the output contains 500 ms of silence at the break position
- AND the phoneme content is synthesized from the given IPA, bypassing G2P

#### Scenario: Missing speak root

- WHEN Ira runs `kesha say --ssml 'Hello <break/> world'`
- THEN the run fails with `E_SSML_INVALID` (`SSML must start with a <speak>
  element`)
- AND the process exits 4

#### Scenario: Unknown tag is stripped, text survives

- WHEN Sona passes `<speak><voice name="x">keep this text</voice></speak>`
- THEN stderr warns once that `<voice>` is not supported
- AND "keep this text" is still synthesized

#### Scenario: DOCTYPE rejected

- WHEN Ira passes SSML containing `<!DOCTYPE foo [...]>`
- THEN the run fails with `E_SSML_INVALID` (`DOCTYPE declarations are not
  supported`) — defense against XXE/billion-laughs

#### Scenario: Relative prosody percentage rejected

- WHEN Maks passes `<speak><prosody rate="+25%">faster</prosody></speak>`
- THEN the run fails with `E_SSML_INVALID` suggesting an absolute percentage
  (`125%`) or a named value instead

#### Scenario: AVSpeech rejects SSML

- WHEN Maks runs `kesha say --ssml --voice macos-en-US '<speak>hi</speak>'`
- THEN the run fails with `E_SSML_UNSUPPORTED`
- AND the process exits 4

> *Technical Note — parser and hardening: `rust/src/tts/ssml/mod.rs:43-82`
> (root check :48, DOCTYPE :59, relative rate :73). Tag behavior table:*
>
> | Tag | Behavior |
> |---|---|
> | `<break time>` | silence; default 250 ms (`segment.rs:38`); capped at `MAX_BREAK_SECS = 30.0` (`rust/src/tts/say.rs:25`) |
> | `<say-as interpret-as="characters">` | letter-spell; other `interpret-as` values warn-strip |
> | `<phoneme alphabet="ipa">` | `ph` fed verbatim to the tokenizer; non-ipa alphabets warn-strip |
> | `<emphasis>` | `+` stress markers honored on `ru-vosk-*` only; `level="none"` suppresses them everywhere |
> | `<prosody rate>` | whole-utterance only; mid-utterance warn-strips; multiplies `--rate`, clamped 0.5–2.0 |
> | anything else | warn once per tag name, strip, keep inner text |
>
> *Inner structural tags win over an enclosing `<emphasis>` (span-priority
> sort, `rust/src/tts/ssml/mod.rs:92-111`). AVSpeech rejection:
> `rust/src/tts/say.rs:136`. FluidAudio Kokoro warn-skips `<phoneme>` (internal
> G2P only) and reads `<say-as characters>` content as plain text
> (`rust/src/tts/say.rs:441-455`).*

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
automatic letter-spelling for English and Russian — but the English IPA lexicon
still fires, and `<say-as interpret-as="characters">` still works.

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

#### Scenario: --no-expand-abbrev on an old engine warns instead of lying

- GIVEN an Engine that does not advertise `tts.ru_acronym_expansion` /
  `tts.en_acronym_expansion` in its Capabilities JSON
- WHEN Ira passes `--no-expand-abbrev`
- THEN the CLI drops the flag from the Engine argv and warns on stderr that it
  requires kesha-engine ≥ 1.10.0 — never a silent drop

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
> untouched. Capability gating of `--no-expand-abbrev`: `src/synth.ts:76-91`.*

### Requirement: Script gates — unsupported writing systems fail fast

On the darwin-arm64 FluidAudio build, Hindi and Japanese voices SHALL reject
text in their native scripts (Devanagari; kana/han for Japanese) with
`E_SCRIPT_UNSUPPORTED` rather than synthesize garbage — romanized text passes
through. Chinese SHALL be supported natively on darwin-arm64 (Han text,
tone-aware Mandarin G2P, voice `zh-zm_050`). Castilian Spanish (`--lang es-ES`)
SHALL synthesize with Latin-American phonology (*seseo*) and print a one-time
stderr note, because the upstream CharsiuG2P export has no Castilian θ tag.

#### Scenario: Maks synthesizes Mandarin on Apple Silicon

- WHEN Maks runs `kesha say --voice zh-zm_050 "你好，我叫凯沙"`
- THEN the Han text is synthesized with Mandarin G2P
- AND the process exits 0

#### Scenario: Devanagari fails fast

- WHEN Maks runs `kesha say --voice hi-hm_omega "नमस्ते"`
- THEN the run fails with `E_SCRIPT_UNSUPPORTED`
- AND the process exits 4

#### Scenario: Romanized Hindi passes the gate

- WHEN Maks runs `kesha say --voice hi-hm_omega "Namaste! Mera naam Kesha hai."`
- THEN synthesis proceeds (the gate checks script, not language)

#### Scenario: Castilian Spanish degrades with a note

- WHEN Ira runs `kesha say --lang es-ES "cielo"`
- THEN stderr carries a one-time note that Castilian (θ) pronunciation is
  unavailable and Latin-American phonology is used
- AND synthesis still succeeds with exit 0

> *Technical Note — script gate: `rust/src/tts/fluid_kokoro.rs:228-234`
> (`ensure_script_supported`); zh Han is allowed for `zm_050`. Castilian
> degrade decision (#511 Phase-0 spike found no working θ tag in the klebster
> CharsiuG2P export): `rust/src/tts/charsiu/mod.rs:46-110`; `es-ES` is detected
> by `is_castilian_region` while `es`/`es-419`/`es-MX` use the LatAm tag
> directly. zh voices are fetched by FluidAudio's own `ANE-zh/` bundle, not
> staged in `rust/src/models.rs`.*

### Requirement: List installed voices

`kesha say --list-voices` SHALL print one installed Voice id per line, sorted,
to stdout and exit 0. The list covers Kokoro voices (the FluidAudio catalog on
darwin-arm64; cached `.bin` packs elsewhere), the five Vosk Russian speakers
when the Vosk model is installed, and the OS-provided `macos-*` voices on
macOS. With nothing installed it SHALL print a `kesha install --tts` hint and
still exit 0.

#### Scenario: Maks lists voices on Apple Silicon

- WHEN Maks runs `kesha say --list-voices`
- THEN stdout lists `en-am_michael`, `es-em_alex`, `zh-zm_050`,
  `ru-vosk-m02`, and his installed `macos-*` voices, sorted
- AND the process exits 0

#### Scenario: Nothing installed yet

- GIVEN a fresh machine with no TTS models
- WHEN Ira runs `kesha say --list-voices`
- THEN stdout reads `No voices installed. Run: kesha install --tts`
- AND the process exits 0

> *Technical Note — enumeration: `rust/src/cli/say.rs:140-163`; the CLI relays
> the Engine's stdout and exit code verbatim (`src/cli/say.ts:157-164`).
> Partial Vosk installs advertise no `ru-vosk-*` voices (same cache gate as
> synthesis). AVSpeech enumeration is best-effort: a missing Sidecar still
> shows Kokoro/Vosk voices.*

### Requirement: Exit codes distinguish failure classes

`kesha say` SHALL exit 0 on success, 1 when the voice is unknown or its model
is not installed, 2 for invalid input (bad flags, empty text, malformed
flag combinations), 4 for synthesis/SSML/internal failures, and 5 when the
text exceeds the length limit. The CLI SHALL propagate the Engine's exit code
unchanged (`SayError.exitCode`); CLI-side pre-checks use the same map.

#### Scenario: Exit-code contract in a script

- GIVEN a shell script that branches on `$?`
- WHEN it runs `kesha say "hi"` / `--voice xx-none "hi"` / `--rate 9 "hi"` /
  `--ssml "no-root"` / a 6000-character input
- THEN it observes exit codes 0, 1, 2, 4, and 5 respectively

#### Scenario: Unexpected internal error maps to 4

- WHEN the Engine subprocess dies without a structured Error code
- THEN the CLI reports the stderr text and exits with the Engine's nonzero
  code, or 4 for non-SayError internal failures

> *Technical Note — Engine map: `rust/src/cli/say.rs:132-138`
> (`exit_code_for_tts_err`: `EmptyText` → 2, `TextTooLong` → 5,
> `SynthesisFailed`/`Coded` → 4); voice resolution failures return 1 directly
> (`rust/src/cli/say.rs:228-235`); format/flag errors return 2
> (`:169-183`, `:220-226`). CLI side: `SayError` carries the Engine exit code
> (`src/cli/say.ts:289-292`); pre-flight checks exit 2
> (`src/cli/say.ts:62-101,204-207`) and 5 (`src/synth.ts:117-125`).
> `E_SSML_INVALID`, `E_SSML_UNSUPPORTED`, and `E_SCRIPT_UNSUPPORTED` all
> surface as `Coded` → exit 4.*

## Open Issues

- **French default voice is female** (`fr-ff_siwis`) — documented brand-rule
  exception; Kokoro v1.0 ships no male French voice. Revisit when one exists.
- **Castilian θ gap (#511)** — `--lang es-ES` synthesizes Latin-American
  phonology with a one-time stderr note; the upstream CharsiuG2P export has no
  Castilian tag.
- **Hindi/Japanese native scripts** fail fast with `E_SCRIPT_UNSUPPORTED` on
  the darwin-arm64 FluidAudio build and have no voices at all on ONNX
  platforms; ja/hi are a future ONNX-CharsiuG2P effort.
- **zh auto-routing drift** — `src/voice-routing.ts:14` maps detected `zh` to
  `zh-zm_yunjian`, but the Engine's FluidAudio catalog ships only `zh-zm_050`
  (`rust/src/tts/fluid_kokoro.rs:169`), so auto-routed Chinese fails with
  `E_VOICE_UNKNOWN` until the map is fixed; explicit `--voice zh-zm_050`
  works.
- **`--rate` is silently ignored for `macos-*` AVSpeech voices** — the
  `EngineChoice::AVSpeech` variant carries no speed field
  (`rust/src/tts/mod.rs:103`); the documented 0.5–2.0 contract only holds for
  Kokoro and Vosk voices.
