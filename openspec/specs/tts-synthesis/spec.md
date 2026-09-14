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
stays empty. All progress and error output SHALL go to stderr. The text SHALL
be validated before any voice is resolved and before any subprocess runs: no
positional argument with a TTY stdin exits 2; an explicitly empty positional
argument (`kesha say ""`) exits 2 with `E_TEXT_EMPTY` without reading stdin;
empty or whitespace-only text exits 2 with `E_TEXT_EMPTY`; text longer than
5000 Unicode characters exits 5 with `E_TEXT_TOO_LONG`; text containing a NUL
byte exits 2 with `E_INVALID_ARG`. The text SHALL never be passed to a
subprocess as an argument (text-language detection reads it on stdin), so no
input length or byte produces a spawn failure or a stack trace. A string-valued
flag given without a value (`--out`, `--voice`, `--lang`, `--format`, `--rate`,
`--bitrate`, `--sample-rate`) SHALL be `error [E_INVALID_ARG]: <flag> needs a
value`, exit 2, with nothing on stdout. An `--out` path that is a character
device (`/dev/stdout`, `/dev/null`, `/dev/fd/N`) SHALL be refused with
`E_INVALID_ARG` naming the plain-stdout default, because the Engine's stdout
is the CLI's pipe and the bytes would be lost; a FIFO or a regular file is
accepted. The `Synthesizing …` progress line SHALL be printed only after every
pre-flight check has passed.

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

#### Scenario: A megabyte on stdin is still a length error

- WHEN Ira runs `kesha say --out big.wav < big1mb.txt` with no `--voice` or `--lang`
- THEN stderr carries one `error [E_TEXT_TOO_LONG]: …` line and nothing else
- AND the process exits 5 without spawning any Engine subprocess

#### Scenario: A NUL byte in the text

- WHEN Maks runs `printf 'null\x00byte' | kesha say --out o.wav`
- THEN stderr carries one `error [E_INVALID_ARG]: text contains a NUL byte` line
- AND the process exits 2 without a stack trace

#### Scenario: An explicit empty argument does not wait on stdin

- WHEN a producer keeps a pipe open and runs `producer | kesha say ""`
- THEN the run fails at once with `E_TEXT_EMPTY` and exits 2
- AND no `Synthesizing …` line was printed

#### Scenario: A flag without its value

- WHEN Ira runs `kesha say hi --out`
- THEN stderr reads `error [E_INVALID_ARG]: --out needs a value`
- AND stdout is empty and the process exits 2 without spawning the Engine

#### Scenario: A character device as the output path

- WHEN Maks runs `kesha say "probe" --out /dev/stdout > out.bin`
- THEN the run fails with `E_INVALID_ARG` telling him to omit `--out` to write to stdout
- AND `out.bin` is empty and the process exits 2

#### Scenario: A FIFO as the output path keeps streaming

- GIVEN `mkfifo pipe.wav` and a reader on it
- WHEN Ira runs `kesha say "probe" --out pipe.wav`
- THEN the reader receives the WAV bytes and the process exits 0

> *Technical Note — the limit is `MAX_TEXT_CHARS = 5000`, counted in Unicode
> code points (`Array.from(text).length` / `chars().count()`), enforced in both
> the CLI (`src/synth.ts::MAX_TEXT_CHARS`, checked in `src/synth.ts::say`) and
> the Engine (`rust/src/tts/mod.rs::MAX_TEXT_CHARS`). TTY guard:
> `src/cli/say.ts::shouldRejectMissingSayText`. Stdin is trimmed before the
> empty check (`src/cli/say.ts::resolveText`,
> `rust/src/cli/say.rs::validate_text`).*

### Requirement: Voice routing resolves --voice, then --lang, then detected language, then the engine default

Voice routing SHALL apply this precedence: an explicit `--voice` wins
unconditionally; otherwise `--lang` maps the stated language to its default
voice via `pickVoiceForLang` without running text-language detection;
otherwise Language detection (text) runs and its result (when confidence is at
least 0.5) is mapped the same way; otherwise the voice is left unset and the
Engine uses its Default voice, `en-am_michael`. A `--lang` value with no
mapped voice SHALL resolve to the engine default rather than re-running
detection. On darwin-arm64, `ja` and `hi` text whose dominant script is native
(kana/han, Devanagari) SHALL route to an installed AVSpeech voice for that
locale, a male one when the machine has it (macOS ships no male `hi-IN` voice, so Hindi
falls to `Lekha`, a documented exception), because the Kokoro `ja`/`hi`
voices handle Latin input only; romanized text keeps routing to the Kokoro
voice. The Voice id scheme is `<lang>-<name>`; the `<lang>` prefix routes to a
TTS engine (Kokoro, Vosk, or AVSpeech), and an unparseable or unsupported
Voice id SHALL fail with `E_VOICE_UNKNOWN` and exit 1, the message listing
every prefix the running build routes.

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
- AND on the darwin-arm64 build that list includes `zh-*`, `ja-*` and `hi-*`
- AND the process exits 1

#### Scenario: Native-script Japanese routes to a system voice on macOS

- GIVEN a Mac with a `ja-JP` AVSpeech voice installed
- WHEN Sona runs `kesha say "こんにちは世界"`
- THEN synthesis uses that `macos-*` voice and exits 0
- AND `--verbose` names the voice that spoke

> *Technical Note — precedence: `src/voice-routing.ts::resolveSayVoice` (shared
> with the MCP server since #942); mapping:
> `src/voice-routing.ts::pickVoiceForLang`, after which
> `src/voice-routing.ts::nativeScriptOverride` swaps the `ja`/`hi` Kokoro voice for
> an installed AVSpeech voice of that locale on darwin when `dominantScript` finds
> more native letters than Latin ones (T2-10). The `pickVoiceForLang` map
> (confidence < 0.5 → none; base code is lowercased and split on `-`/`_`):*
>
> | Detected/stated lang | darwin-arm64 | darwin-x64 (Intel macOS) | Linux / Windows |
> |---|---|---|---|
> | `en` | `en-am_michael` | `en-am_michael` | `en-am_michael` |
> | `ru` | `macos-com.apple.voice.compact.ru-RU.Milena` | `macos-com.apple.voice.compact.ru-RU.Milena` | `ru-vosk-m02` |
> | `es` | `es-em_alex` | `es-em_alex` | `es-em_alex` |
> | `fr` | `fr-ff_siwis` | `fr-ff_siwis` | `fr-ff_siwis` |
> | `hi` | `hi-hm_omega` | *(unmapped)* | *(unmapped)* |
> | `it` | `it-im_nicola` | `it-im_nicola` | `it-im_nicola` |
> | `ja` | `ja-jm_kumo` | *(unmapped)* | *(unmapped)* |
> | `pt` | `pt-pm_alex` | `pt-pm_alex` | `pt-pm_alex` |
> | `zh` | `zh-zm_050` | *(unmapped)* | *(unmapped)* |
>
> *The platform split differs by row: `ru` routes on `platform === "darwin"`
> (so Intel macOS gets AVSpeech Milena, not Vosk), while the multilingual rows
> route on `platform === "darwin" && arch === "arm64"` (so Intel macOS follows
> the Linux/Windows ONNX column). `*(unmapped)*` means `pickVoiceForLang`
> returns `undefined` and the Engine default applies.*
>
> *Engine-side routing (`rust/src/tts/voices.rs::resolve_voice`): `en-*` → Kokoro;
> `es/fr/hi/it/ja/pt/zh-*` → FluidAudio Kokoro on the darwin-arm64
> `system_kokoro` build, `es/fr/it/pt-*` → ONNX Kokoro elsewhere; `ru-*` →
> Vosk (the `vosk-` infix is optional; speakers map `f01→0, f02→1, f03→2,
> m01→3, m02→4`, `rust/src/tts/voices.rs::resolve_vosk_ru`); `macos-*` →
> AVSpeech (suffix forwarded as identifier or language code; empty suffix
> rejected). Engine default: `DEFAULT_VOICE_ID = "en-am_michael"`
> (`rust/src/tts/voices.rs::DEFAULT_VOICE_ID`).*

### Requirement: Default voices are male

Every Default voice SHALL be male — Kesha is a male brand voice. The English
default is `en-am_michael`; the Russian Vosk default is `ru-vosk-m02`; Spanish,
Italian, and Portuguese default to `es-em_alex`, `it-im_nicola`, and
`pt-pm_alex`. There are three documented exceptions. French: Kokoro v1.0 ships no
male French voice, so `fr` defaults to `fr-ff_siwis` (female) until a male
French voice exists. Russian on darwin-arm64: with no `--voice`, `ru` routes to
AVSpeech `macos-com.apple.voice.compact.ru-RU.Milena` (female) because it is
the zero-install path; `--voice ru-vosk-m02` opts into the male Vosk voice. Hindi in
Devanagari on darwin-arm64: the native-script route takes the only `hi-IN` AVSpeech
voice macOS ships, `Lekha` (female), because there is no male one.

#### Scenario: Default English voice is male

- WHEN Maks runs `kesha say "Good morning"` with no voice flags and English
  detected
- THEN synthesis uses `en-am_michael` (American male)

#### Scenario: French falls back to the documented female exception

- WHEN Ira runs `kesha say --voice fr- "Bonjour"` on a Linux runner
- THEN the Engine resolves the empty name to the language default `ff_siwis`
- AND this is the documented brand-rule exception, not a regression

#### Scenario: The three documented exceptions are the only female defaults

- WHEN Ira lists the default voice of every routed language on darwin-arm64
- THEN every default is male except `fr-ff_siwis`, the darwin `ru` route to Milena and the darwin Devanagari `hi` route to Lekha

> *Technical Note — per-language defaults:
> `rust/src/tts/voices.rs::default_voice_for_lang`, with the brand-rule
> exception comment inline.
> Female Vosk voices `ru-vosk-f01/f02/f03` stay selectable via explicit
> `--voice`.*

### Requirement: TTS models are never auto-downloaded

Synthesis SHALL fail loudly — never download — when the required TTS model is
not in the Model cache. The failure carries Error code `E_MODEL_MISSING` and an
actionable `kesha install --tts` hint, and exits 1 — the voice is rejected
while it is being resolved, before synthesis starts.

On darwin-arm64 the FluidAudio Kokoro voices are not gated by the Model cache,
so the guarantee rests on a check of its own: before the FluidAudio bridge is
initialized, synthesis SHALL confirm that every asset the requested voice needs
— its bundle's model chain, that voice's own pack, and the variant's G2P assets
— is already on disk, and refuse with `E_MODEL_MISSING` when any is absent.
Refusing up front is what makes the rule hold there, because upstream's asset
downloader consults no offline switch and would otherwise fetch a voice pack
that `kesha install --tts <other-lang>` never staged. The message SHALL name
the first few missing paths so the gap is identifiable, and the refusal exits 4
(the `kesha say` code for a coded synthesis failure), not 1.

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

#### Scenario: Mandarin voice on an English-only Apple Silicon install

- GIVEN a darwin-arm64 machine where only `kesha install --tts en` has run
- WHEN Maks runs `kesha say --voice zh-zm_050 "你好"`
- THEN stderr carries Error code `E_MODEL_MISSING`, names missing asset paths,
  and hints `kesha install --tts zh`
- AND the process exits 4 without downloading anything

> *Technical Note — model presence gates:
> `rust/src/tts/voices.rs::build_kokoro_voice` (ONNX Kokoro) and
> `::resolve_vosk_ru` (Vosk). `macos-*` voices need no model download.
> The darwin-arm64 pre-check is `rust/src/models/staging.rs::missing_kokoro_assets`,
> called from `rust/src/tts/fluid_kokoro.rs::with_kokoro` alongside
> `fluidaudio_rs::set_offline_mode(true)` — two defences because neither covers
> the other: the flag stops upstream's repo downloads but not its
> `AssetDownloader` (#823). Its required set is derived from the same staging
> manifests the install uses, so a manifest change cannot leave the check
> behind. The error is a `CodedError { ModelMissing }` that reaches the caller
> as `TtsError::Coded`, hence exit 4 rather than the 1 a voice-resolution
> failure returns; a file that exists but is truncated slips past and surfaces
> as the same message from FluidAudio's `AssetsUnavailable`. What install
> stages: installation spec, "On darwin-arm64, `--tts` stages FluidAudio's
> Kokoro assets outside the Model cache".*

### Requirement: Output formats — wav, ogg-opus, flac

The CLI SHALL produce one of three Output formats (TTS): **wav** (default;
IEEE-float mono at the engine's native sample rate), **ogg-opus** (mono Opus in
an OGG container; `--bitrate` 6000–510000 bps, default 32000; `--sample-rate`
one of 8000/12000/16000/24000/48000 Hz, default 24000), and **flac** (lossless
16-bit, native rate, no encoder knobs). When `--format` is omitted the format
SHALL be inferred from the `--out` extension (`.wav` → wav; `.ogg`/`.opus`/
`.oga` → ogg-opus; `.flac` → flac; anything else → wav). `opus` and `ogg`
SHALL be accepted as aliases for `ogg-opus`. An unknown `--format` value exits
2, and `--bitrate`/`--sample-rate` with any non-opus format also exit 2. A
`--bitrate` outside 6000–510000 SHALL be rejected with `E_INVALID_ARG` exit 2
by the CLI before the spawn and by the Engine before synthesis, never after
audio has been produced.

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
- THEN stderr reads `error [E_INVALID_ARG]: --bitrate must be between 6000 and 510000 bps`
- AND the process exits 2 without synthesizing anything

> *Technical Note — format parsing and aliases:
> `rust/src/tts/encode.rs::OutputFormat::from_str` mirrored in
> `src/cli/say.ts::parseFormatFlag`; extension inference:
> `rust/src/tts/encode.rs::format_from_extension`, resolution order
> (`--format` > `--out` extension > wav default):
> `rust/src/cli/say.rs::resolve_output_format`. Opus constraints: `OPUS_VALID_SR = {8000, 12000, 16000, 24000, 48000}`
> (`rust/src/tts/encode.rs::OPUS_VALID_SR`), bitrate `6000..=510000`
> (both checked in `rust/src/tts/encode.rs::encode_ogg_opus`), defaults 32000 bps
> / 24000 Hz (`rust/src/tts/encode.rs::OutputFormat::ogg_opus_default`). Native
> rates: Kokoro 24 kHz, Vosk 22.05 kHz (resampled for Opus, kept as-is for
> wav/flac). FLAC quantizes f32 to 16-bit PCM
> (`rust/src/tts/encode.rs::encode_flac`). The CLI pre-validates knob/format
> combinations (`src/cli/say.ts::resolveSayFlags`); the Engine repeats the check
> authoritatively.*

### Requirement: Speaking rate is bounded

The CLI SHALL accept `--rate` between 0.5 and 2.0 inclusive (default 1.0) and
exit 2 for values outside that range or non-numeric values. The Engine SHALL
enforce the same bounds itself on every door (`say` and `--stdin-loop`),
answering `E_INVALID_ARG` exit 2 for a non-finite or out-of-range rate before
any synthesis engine is chosen, so a caller that bypasses the CLI never reaches
a trap. Any text the Engine can synthesize at rate 1.0 SHALL synthesize at
every rate in the range: on the darwin-arm64 FluidAudio path the text is
chunked by a budget that scales with the rate and the chunks are rejoined at
their seams, so the upstream acoustic-frame cap is never visible to the user.

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

#### Scenario: The Engine refuses a rate it cannot run

- WHEN a caller runs `kesha-engine say --rate 0 "hello"` directly
- THEN stderr carries one `error` event with code `E_INVALID_ARG` naming the 0.5–2.0 range
- AND the process exits 2 rather than dying with a signal and empty output

#### Scenario: Slow narration of a long paragraph

- GIVEN 600 words of unpunctuated English text
- WHEN Maks runs `kesha say --rate 0.5 "$(cat words.txt)" --out slow.wav`
- THEN the run exits 0 and every word of the input survives the ASR round trip of `slow.wav`

> *Technical Note — validation: `src/cli/say.ts::parseRateFlag`. The CLI omits
> `--rate` from the Engine argv when it equals 1.0
> (`src/synth.ts::buildSayArgs`). An SSML
> whole-utterance `<prosody rate>` multiplies with `--rate`; the product is
> clamped to 0.5–2.0 (`rust/src/tts/ssml/rate.rs`). For `macos-*` AVSpeech voices
> the multiplier is forwarded to the sidecar as `--rate <value>`
> (`rust/src/tts/avspeech.rs::synthesize`) and mapped piecewise-linearly onto
> `AVSpeechUtterance.rate` (user 0.5/1.0/2.0 → AVSpeech 0.0/0.5/1.0), #546.*

### Requirement: SSML subset with strict root and graceful tag degradation

With `--ssml`, the input SHALL be parsed as SSML and SHALL start with a
`<speak>` root element; anything else fails with `E_SSML_INVALID`. Every parse
error, including a malformed attribute value such as `<break time="abc"/>`,
SHALL be `E_SSML_INVALID` naming the tag and the accepted forms, never
`E_INTERNAL`. Supported tags: `<break time="...">` (silence, default 250 ms,
capped at 30 s), `<say-as interpret-as="characters">` (letter-by-letter
spelling), `<phoneme alphabet="ipa" ph="...">` (bypasses G2P where the engine
accepts IPA; `alphabet` defaults to ipa), `<emphasis>` (stress hint;
`level="none"` strips `+` stress markers), and `<prosody rate="...">` when it
wraps the entire utterance. A `<break>` SHALL add exactly the silence it asks
for: the synthesized runs on either side are trimmed of the engine's own edge
padding before the silence is inserted, so ten `500ms` breaks add about five
seconds, not nine. On an engine with no IPA input (darwin-arm64 FluidAudio
Kokoro) `<phoneme>` SHALL be stripped with one stderr warning and its wrapped
text spoken. CDATA sections SHALL be spoken as text. A document with no
speakable content after parsing SHALL fail with `E_TEXT_EMPTY`. Unknown tags
SHALL emit one stderr warning per tag name and be stripped with their text
content preserved. `<!DOCTYPE>` anywhere in the document SHALL be rejected
(`E_SSML_INVALID`), as SHALL relative-percent prosody rates (`+25%`/`-25%`).
AVSpeech (`macos-*`) voices SHALL reject `--ssml` entirely with
`E_SSML_UNSUPPORTED`.

#### Scenario: Maks adds a pause and a phoneme override

- WHEN Maks runs
  `kesha say --ssml '<speak>Kesha <break time="500ms"/> <phoneme alphabet="ipa" ph="ˈkeʃa">Kesha</phoneme></speak>'`
- THEN the output contains 500 ms of silence at the break position
- AND on ONNX Kokoro the phoneme content is synthesized from the given IPA, bypassing G2P
- AND on darwin-arm64 FluidAudio Kokoro the word `Kesha` is spoken from its text with one warning

#### Scenario: Missing speak root

- WHEN Ira runs `kesha say --ssml 'Hello <break/> world'`
- THEN the run fails with `E_SSML_INVALID` (`SSML must start with a <speak>
  element`)
- AND the process exits 2

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

#### Scenario: A break is exactly as long as asked

- WHEN Ira compares `<speak>one two</speak>` with `<speak>one <break time="1s"/> two</speak>` on `en-am_michael`
- THEN the second file is longer by about one second, within 150 ms
- AND `<break time="0ms"/>` adds no measurable silence

#### Scenario: A malformed break attribute

- WHEN Sona runs `kesha say --ssml '<speak>one <break time="abc"/> two</speak>'`
- THEN the run fails with `E_SSML_INVALID` naming `<break time>` and the accepted `Nms` / `Ns` forms
- AND the process exits 2

#### Scenario: CDATA is spoken

- WHEN Maks runs `kesha say --ssml '<speak><![CDATA[hello there]]></speak>' --out c.wav`
- THEN `c.wav` round-trips through ASR as "hello there"

#### Scenario: A lone phoneme on darwin still produces audio

- GIVEN the darwin-arm64 FluidAudio build
- WHEN Ira runs `kesha say --ssml '<speak><phoneme ph="ˈkeʃa">Kesha</phoneme></speak>' --out p.wav`
- THEN `p.wav` contains speech and stderr warns once that the text is read instead of the IPA
- AND the process exits 0

> *Technical Note — parser and hardening: `rust/src/tts/ssml/mod.rs::parse`
> (the `<speak>` root check, `rust/src/tts/ssml/mod.rs::contains_doctype`, and
> the relative-rate rejection via `rust/src/tts/ssml/rate.rs::find_relative_rate`).
> Tag behavior table:*
>
> | Tag | Behavior |
> |---|---|
> | `<break time>` | silence; default 250 ms (`rust/src/tts/ssml/segment.rs::DEFAULT_BREAK`); capped at `MAX_BREAK_SECS = 30.0` (`rust/src/tts/say.rs::MAX_BREAK_SECS`) |
> | `<say-as interpret-as="characters">` | letter-spell; other `interpret-as` values warn-strip |
> | `<phoneme alphabet="ipa">` | `ph` fed verbatim to the tokenizer; non-ipa alphabets warn-strip |
> | `<emphasis>` | `+` stress markers honored on `ru-vosk-*` only; `level="none"` suppresses them everywhere |
> | `<prosody rate>` | whole-utterance only; mid-utterance warn-strips; multiplies `--rate`, clamped 0.5–2.0 |
> | anything else | warn once per tag name, strip, keep inner text |
>
> *Inner structural tags win over an enclosing `<emphasis>` (the span sort in
> `rust/src/tts/ssml/mod.rs::parse`, keyed by
> `rust/src/tts/ssml/walker.rs::span_priority`). AVSpeech rejection:
> `rust/src/tts/say.rs::say_avspeech`. FluidAudio Kokoro warn-skips `<phoneme>`
> (internal G2P only) and reads `<say-as characters>` content as plain text
> (`rust/src/tts/say.rs::FluidKokoroSink`).*

### Requirement: Text normalization expands acronyms and numbers per language

Normalization SHALL run before G2P. English: uppercase tokens of 2–5
characters are letter-spelled unless they appear on the English stop-list or in
the IPA lexicon (which supplies a fixed pronunciation); currency amounts
(`$`, `€`, `£` followed by digits, with an optional decimal part) and
comma-grouped integers (`1,234,567`) are verbalized with their unit ("one
thousand two hundred thirty four dollars and fifty six cents") before the text
reaches any English engine, including the darwin-arm64 FluidAudio handoff, and
exactly once on every path. Russian (`ru-vosk-*`): all-caps Cyrillic tokens of
2–5 letters are letter-spelled when they fail the pronounceability heuristic
(strict consonant-vowel alternation reads as a word) and are not on the
Russian stop-list; a phone-shaped token (leading `+` or `8`, ten or more
digits separated by spaces, hyphens or parentheses) is read digit by digit as
one token, while ranges such as «10-15» keep their cardinal reading.
Spanish/French/Italian/Portuguese: integers 0–999,999 are expanded to words and
2–5-character uppercase acronyms are letter-spelled with that language's
letter names, with per-language stop-lists exempting word-acronyms.
`--no-expand-abbrev` SHALL disable the automatic letter-spelling for Russian
and for English on ONNX Kokoro builds — but the English IPA lexicon still
fires, and `<say-as interpret-as="characters">` still works. On every other
path — FluidAudio Kokoro, `macos-*` AVSpeech, and the Romance normalizer that
runs inside CharsiuG2P — expansion belongs to an engine that offers no
suppression knob, and the Engine SHALL emit a `warn` event on the Event stream
rather than accept the flag silently; the CLI SHALL render that warning on
stderr on a successful run.

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
- THEN the CLI omits the flag from the argv it spawns, because the schema row
  is `whenUngated: drop`, and renders one warning naming the flag and the
  features this build lacks — never a silent drop, never a refusal of a
  request the Engine can otherwise serve

#### Scenario: English currency is spoken with its unit

- WHEN Ira runs `kesha say --voice en-am_michael 'It costs $1,234.56' --out n.wav`
- THEN `n.wav` round-trips through ASR with the amount and the word "dollars"
- AND `$5` is read as "five dollars"

#### Scenario: A formatted Russian phone number is read digit by digit

- WHEN Maks runs `kesha say --voice ru-vosk-m02 '+7 999 123-45-67' --out p.wav`
- THEN `p.wav` round-trips as eleven single digits
- AND «с 10-15 мая» still reads the range as two cardinals

> *Technical Note — the `protocol-v4` delta (archived) wrote this scenario as
> a refusal, where the spec before it had drop-and-warn with a version remedy; the landed row is `whenUngated: drop` and the warning
> is built by `validateArgv` (`src/engine/describe.ts`, drop branch), so the
> main spec was corrected at the archive sync (PR #1191) rather than the code.*

> *Technical Note — English: 30-entry stop-list (OK/NO/GO/…/NASA/NATO/AIDS/
> OPEC/IKEA/ASCII/NAFTA/LASER/RADAR/SCUBA) and IPA lexicon (EPAM, JSON, JPEG,
> GIF, SQL, ASAP, CRUD, JWT, OAuth, Microsoft, Anthropic, Claude, Kubernetes,
> PostgreSQL, GraphQL, Linux, Tokio, macOS, Granola) in
> `rust/src/tts/en/acronym.rs` (`STOP_LIST`, `IPA_LEXICON`); the lexicon fires
> even with `--no-expand-abbrev` (test `ipa_fires_even_without_auto_expand`).
> Russian: rules and 25-entry stop-list (ВСЁ, ВЫ, ДА, …, ЧТО) in
> `rust/src/tts/ru/acronym.rs::STOP_LIST`; tokens must be 2–5 chars of `[А-ЯЁ]`
> without Ъ/Ь, and spell only when length ≤ 2 or an adjacent same-type letter
> pair exists (`rust/src/tts/ru/acronym.rs::is_acronym_token`). Romance languages: numbers 0–999,999
> (`rust/src/tts/normalize/numbers.rs`), letter tables and stop-lists
> `ES_STOP_LIST` = OTAN, OVNI, SIDA, OPEP, OEA, ONU, FIFA, OMS;
> `FR_STOP_LIST` = OTAN, OVNI, SIDA, FIFA, OPEP, ONU, OMS;
> `IT_STOP_LIST` = FIAT, NATO, FIFA, AIDS, ONU;
> `PT_STOP_LIST` = OTAN, OVNI, SIDA, AIDS, FIFA, ONU, OMS
> (`rust/src/tts/normalize/acronyms.rs`, the `*_STOP_LIST` constants beside
> the `*_LETTERS` tables) — curated seeds, not
> exhaustive. Six-plus-character all-caps words (UNESCO) pass through
> untouched. The hand-written capability gate of `--no-expand-abbrev` that
> `src/synth.ts` once carried (`applyNoExpandAbbrev`) is replaced by the
> generic `validateArgv` in `src/engine/describe.ts`.*

### Requirement: Script gates — unsupported writing systems fail fast

The Engine SHALL classify the input's letters by writing system before inference on
every arm that phonemizes the text itself (ONNX Kokoro, FluidAudio Kokoro and Vosk),
after NFKC normalisation so fullwidth Latin counts as Latin, and compare them with the scripts the chosen voice's G2P handles: Latin for `en-*`,
`es-*`, `fr-*`, `it-*`, `pt-*`, `hi-*` and `ja-*`; Cyrillic for `ru-vosk-*`;
Han and Latin for `zh-*`. When the dominant script (more than half of the
letters) is one the voice cannot pronounce, the run SHALL fail before any model
loads with `E_SCRIPT_UNSUPPORTED` naming the script and the voice, and the hint
SHALL list installed voices that handle that script (on darwin-arm64 the
`macos-*` voices for the matching locale). When only a minority of the letters
are in an unsupported script, synthesis SHALL proceed and one `warn` event
SHALL name the tokens that will be mispronounced, for every unsupported script the
text contains. Text with no pronounceable
content at all (emoji only, punctuation only) and a single token the G2P
rejects SHALL be `E_SCRIPT_UNSUPPORTED`, never `E_INTERNAL` and never a raw
library line. Chinese SHALL be supported natively on darwin-arm64 (Han text,
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

#### Scenario: An English voice given Devanagari

- WHEN Maks runs `kesha say --voice en-am_michael 'नमस्ते'`
- THEN the run fails with `E_SCRIPT_UNSUPPORTED` naming Devanagari and `en-am_michael` within 200 ms
- AND the hint names an installed voice that can speak it, when one exists

#### Scenario: A Russian sentence naming an English product

- WHEN Ira runs `kesha say --voice ru-vosk-m02 'Установи Kesha Voice Kit сегодня'`
- THEN synthesis proceeds and exits 0
- AND stderr carries one warning naming `Kesha`, `Voice` and `Kit` as tokens the voice cannot pronounce

#### Scenario: Emoji-only text

- WHEN Sona runs `kesha say --voice en-am_michael "🎉"`
- THEN stderr carries exactly one `error [E_SCRIPT_UNSUPPORTED]: …` line
- AND the input is not echoed back and no raw engine line appears

> *Technical Note — script gate:
> `rust/src/tts/fluid_kokoro.rs::ensure_script_supported`; zh Han is allowed for
> `zm_050`. Castilian degrade decision (#511 Phase-0 spike found no working θ
> tag in the klebster CharsiuG2P export):
> `rust/src/tts/charsiu/mod.rs::Charsiu::to_ipa`; `es-ES` is detected by
> `rust/src/tts/charsiu/mod.rs::is_castilian_region` while `es`/`es-419`/`es-MX`
> use the LatAm tag directly. zh runs off FluidAudio's separate Mandarin (`ANE-zh/`) bundle,
> which `kesha install --tts zh` stages like every other model — voice packs
> and pinyin dictionaries included (`rust/src/models/manifest.rs::ANE_ZH_FILES`,
> `ANE_ZH_G2P_ASSETS`, #823).*

### Requirement: List installed voices

`kesha say --list-voices` SHALL print one installed Voice id per line, sorted,
to stdout and exit 0. The list covers Kokoro voices (the FluidAudio catalog on
darwin-arm64; cached `.bin` packs elsewhere), the five Vosk Russian speakers
when the Vosk model is installed, and the OS-provided `macos-*` voices on
macOS. With nothing installed stdout SHALL be empty, the `kesha install --tts`
hint SHALL be emitted as a `progress` event on stderr, and the process SHALL
still exit 0: stdout is the list, and a sentence there is a Voice id to every
consumer of the list — the MCP `list_voices` tool reported it as one voice with
an unknown model and no language (#1168).

#### Scenario: Maks lists voices on Apple Silicon

- WHEN Maks runs `kesha say --list-voices`
- THEN stdout lists `en-am_michael`, `es-em_alex`, `zh-zm_050`,
  `ru-vosk-m02`, and his installed `macos-*` voices, sorted
- AND the process exits 0

#### Scenario: Nothing installed yet

- GIVEN a fresh machine with no TTS models
- WHEN Ira runs `kesha say --list-voices`
- THEN stdout is empty
- AND stderr carries a `progress` event reading `No voices installed. Run: kesha install --tts`
- AND the process exits 0

> *Technical Note — enumeration: the `list_voices` branch of
> `rust/src/cli/say.rs::run`; the CLI passes the Engine's stdout ids and exit
> code through (`src/synth.ts::listVoiceIds`, shared by the `kesha say` flag
> and the MCP `list_voices` tool: blank lines dropped, a non-event stderr line
> is `E_INTERNAL`). Under `--quiet` the hint is silenced like any other
> progress event, so a fresh machine prints nothing and exits 0. Partial Vosk
> installs advertise no `ru-vosk-*` voices (same cache gate as synthesis).
> AVSpeech enumeration is best-effort: a missing Sidecar still shows
> Kokoro/Vosk voices.*

### Requirement: Exit codes distinguish failure classes

`kesha say` SHALL exit 0 on success, 1 for an operational failure (an unknown
or uninstalled voice, a model or sidecar absent from where the run looks for
it, on every engine path alike), 2 for invalid input (bad flags, a flag
without a value, empty text, malformed flag combinations, malformed SSML, an
unwritable or device `--out`, a rate or bitrate out of range), 4 for a failure
raised during synthesis that the caller could not have avoided (an unsupported
script or SSML on this engine, an uncoded internal failure), and 5 when the
text exceeds the length limit. The Error code says what went wrong; the exit
code is derived from the code's class, not from how far the run got, so
`E_MODEL_MISSING` exits 1 whether Vosk or the darwin-arm64 FluidAudio
pre-check raised it. The CLI SHALL propagate the Engine's exit code unchanged
(`KeshaError.exitCode`); CLI-side pre-checks use the same map. A missing or
non-executable `say-avspeech` sidecar SHALL be `E_SIDECAR_MISSING` (exit 1)
naming the expected path beside the Engine binary, never a build-machine path;
a `macos-*` voice the machine has not downloaded SHALL be `E_VOICE_UNKNOWN`
(exit 1) with a hint naming System Settings and `--list-voices`.

#### Scenario: Exit-code contract in a script

- GIVEN a shell script that branches on `$?`
- WHEN it runs `kesha say "hi"` / `--voice xx-none "hi"` / `--rate 9 "hi"` /
  `--voice hi-hm_omega "नमस्ते"` / a 6000-character input
- THEN it observes exit codes 0, 1, 2, 4, and 5 respectively

#### Scenario: Unexpected internal error maps to 4

- WHEN the Engine subprocess dies without emitting an `error` event
- THEN the CLI reports the captured stderr and exits with the Engine's nonzero
  code, or 4 when no `KeshaError` carried one

#### Scenario: A missing FluidAudio voice pack is operational, not internal

- GIVEN the darwin-arm64 build without the Italian voice pack staged
- WHEN Maks runs `kesha say --voice it-im_nicola "Ciao"`
- THEN the run fails with `E_MODEL_MISSING` and the `kesha install --tts it` hint
- AND the process exits 1, the same code the Vosk path uses

#### Scenario: A system voice that is not downloaded

- WHEN Ira runs `kesha say --voice macos-com.apple.voice.premium.en-US.Zoe "hi"`
- THEN the run fails with `E_VOICE_UNKNOWN` and a hint naming System Settings
- AND the process exits 1

#### Scenario: The sidecar is missing

- GIVEN `say-avspeech` was removed from beside the Engine binary
- WHEN Maks runs `kesha say --voice macos-com.apple.voice.compact.ru-RU.Milena "Привет"`
- THEN the run fails with `E_SIDECAR_MISSING` naming the sibling path and the reinstall hint
- AND the process exits 1

> *Technical Note — Engine map: `rust/src/cli/say.rs::exit_code_for_tts_err`,
> keyed on the Error code (`E_MODEL_MISSING`, `E_MODEL_DOWNLOAD`, `E_CACHE_CORRUPT`,
> `E_MODEL_LOAD`, `E_SIDECAR_MISSING`, `E_VOICE_UNKNOWN` → 1; `E_INVALID_ARG`,
> `E_SSML_INVALID`, `E_TEXT_EMPTY` → 2; `E_TEXT_TOO_LONG` → 5; every other code and
> an uncoded synthesis failure → 4). Voice
> resolution failures return 1 from `rust/src/cli/say.rs::resolve_voice`, which
> is where the `ModelMissing` bails in
> `rust/src/tts/voices.rs::build_kokoro_voice` (ONNX Kokoro) and
> `rust/src/tts/voices.rs::resolve_vosk_ru` surface; `--model`/`--voice-file`
> and output-format errors return 2 from `resolve_voice` and
> `rust/src/cli/say.rs::run`.
> `E_SSML_UNSUPPORTED`, `E_SCRIPT_UNSUPPORTED` and the darwin-arm64 late
> `E_MODEL_MISSING` from `models::missing_kokoro_assets` all reach the caller as
> `TtsError::Coded`, so the code alone decides the exit: 4 for the first two, 1 for
> the missing pack. CLI side: `KeshaError`
> (`src/engine/events.ts`) carries the Engine exit code exactly as `SayError`
> did (`src/synth.ts::SayError`, now a `KeshaError` subclass), and
> `src/synth.ts::say` pre-checks empty text (2) and the length limit (5).*

## Open Issues

- **French default voice is female** (`fr-ff_siwis`) — documented brand-rule
  exception; Kokoro v1.0 ships no male French voice. Revisit when one exists.
- **Castilian θ gap (#511)** — `--lang es-ES` synthesizes Latin-American
  phonology with a one-time stderr note; the upstream CharsiuG2P export has no
  Castilian tag.
- **Hindi/Japanese native scripts** fail fast with `E_SCRIPT_UNSUPPORTED` on
  the darwin-arm64 FluidAudio build and have no voices at all on ONNX
  platforms; ja/hi are a future ONNX-CharsiuG2P effort.
