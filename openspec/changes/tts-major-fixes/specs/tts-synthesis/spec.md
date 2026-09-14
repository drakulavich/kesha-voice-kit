## MODIFIED Requirements

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

#### Scenario: Bitrate out of the Opus range

- WHEN Ira runs `kesha say --format ogg-opus --bitrate 1000 "test"`
- THEN stderr reads `error [E_INVALID_ARG]: --bitrate must be between 6000 and 510000 bps`
- AND the process exits 2 without synthesizing anything

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

### Requirement: SSML subset with strict root and graceful tag degradation

With `--ssml`, the input SHALL be parsed as SSML and SHALL start with a
`<speak>` root element; anything else fails with `E_SSML_INVALID`. Every parse
error, including a malformed attribute value such as `<break time="abc"/>`,
SHALL be `E_SSML_INVALID` naming the tag and the accepted forms, never
`E_INTERNAL`. Supported tags: `<break time="...">` (silence, default 250 ms,
capped at 30 s), `<say-as interpret-as="characters">` (letter-by-letter
spelling), `<phoneme alphabet="ipa" ph="...">` (bypasses G2P where the engine
accepts IPA; `alphabet` defaults to ipa), `<emphasis>` (stress hint;
`level="none"` strips `+` stress markers), and `<prosody rate="..."`> when it
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

#### Scenario: English currency is spoken with its unit

- WHEN Ira runs `kesha say --voice en-am_michael 'It costs $1,234.56' --out n.wav`
- THEN `n.wav` round-trips through ASR with the amount and the word "dollars"
- AND `$5` is read as "five dollars"

#### Scenario: A formatted Russian phone number is read digit by digit

- WHEN Maks runs `kesha say --voice ru-vosk-m02 '+7 999 123-45-67' --out p.wav`
- THEN `p.wav` round-trips as eleven single digits
- AND «с 10-15 мая» still reads the range as two cardinals

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

#### Scenario: The three documented exceptions are the only female defaults

- WHEN Ira lists the default voice of every routed language on darwin-arm64
- THEN every default is male except `fr-ff_siwis`, the darwin `ru` route to Milena and the darwin Devanagari `hi` route to Lekha

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

#### Scenario: Unexpected internal error maps to 4

- WHEN the Engine subprocess dies without emitting an `error` event
- THEN the CLI reports the captured stderr and exits with the Engine's nonzero
  code, or 4 when no `KeshaError` carried one
