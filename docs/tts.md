# Text-to-Speech

Kesha speaks back via Kokoro-82M (English, Spanish, French, Italian and Portuguese on every build; Hindi, Japanese and Chinese on Apple Silicon) and Vosk-TTS (Russian). On macOS the voice is picked from the input text's own language; on Linux and Windows mostly-Cyrillic text still gets `ru-vosk-m02`, and other languages need `--lang` or `--voice` (precedence below). On darwin-arm64 release builds, Kokoro runs through FluidAudio CoreML instead of the ONNX Kokoro model; Linux/Windows keep the ONNX path. See [where the files live](#where-the-files-live).

```bash
kesha say "Hello, world" > hello.wav
kesha say "Привет, мир" > privet.wav    # auto-routes (Milena on darwin, ru-vosk-m02 elsewhere)
echo "long text" | kesha say > reply.wav
kesha say --out reply.wav "text"
kesha say --out - "text" > reply.wav   # - means stdout; a file named - is ./-
kesha say --voice en-am_michael "text"    # explicit voice overrides auto-routing
kesha say --lang es "Hola, mundo" > hola.wav   # route by stated language, skip detection
kesha say --list-voices
```

Voice selection precedence: `--voice <id>` (explicit) → `--lang <code>` (route to that language's default voice, skipping detection — also the way to route on Linux/Windows, where text-language detection is macOS-only) → macOS text-language auto-detection → Russian when detection is inconclusive or unavailable and most words are Cyrillic ([#1387](https://github.com/drakulavich/kesha-voice-kit/issues/1387)) → engine default (`en-am_michael`). A `--lang` whose language has no mapped voice on the current platform (e.g. `hi` on Linux) falls to the engine default rather than re-detecting.

Output format: WAV (default, mono float32 — 24 kHz for Kokoro, 22.05 kHz for Vosk), OGG/Opus (`--format ogg-opus`), and FLAC (`--format flac`) are all supported. An `--out` extension other than `.wav`, `.ogg`, `.opus`, `.oga` or `.flac` (such as `.mp3`) is refused with `E_INVALID_ARG`; a name with no extension gets WAV. MP3/AAC output were evaluated and rejected on licensing/patent grounds — see [docs/decision-log.md](decision-log.md).

## Installing TTS languages

`kesha install --tts [<lang>...]` installs TTS model packs for the requested languages. Bare `--tts` defaults to English only. Re-running is additive — already-cached packs are skipped, nothing is pruned.

```bash
kesha install --tts              # English only (~326 MB on Linux/Windows, ~105 MB on Apple Silicon)
kesha install --tts en ru        # English + Russian (~326 MB + ~937 MB)
kesha install --tts es fr it pt  # Romance languages (shared ~100 MB CharsiuG2P ONNX pack + voice files)
```

**Platform availability:**

| Language | Code | All builds | darwin-arm64 only |
|----------|------|:----------:|:-----------------:|
| English | `en` | ✅ | |
| Spanish | `es` | ✅ | |
| French | `fr` | ✅ | |
| Italian | `it` | ✅ | |
| Portuguese | `pt` | ✅ | |
| Russian | `ru` | ✅ | |
| Hindi | `hi` | | ✅ |
| Japanese | `ja` | | ✅ |
| Chinese | `zh` | | ✅ |

`macos-*` voices need no install; see [macOS system voices](#macos-system-voices).

Requesting a language unavailable on the current platform (e.g. `hi` on Linux) is a hard error — nothing is downloaded.

`kesha init` presents a multi-select checkbox of the languages available on your platform, with English pre-checked. Selecting none skips TTS entirely; Ctrl-C aborts init.

Grapheme-to-phoneme:
- **Kokoro on darwin-arm64** uses FluidAudio CoreML/ANE for English, Spanish, Hindi, Italian, Japanese, Mandarin Chinese, Brazilian Portuguese, and the single native French Kokoro voice.
- **English on other platforms** uses [misaki-rs](https://github.com/MicheleYin/misaki-rs) plus the ONNX Kokoro model.
- **Spanish, French, Italian and Portuguese on other platforms** use [CharsiuG2P](https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx) (the shared ~100 MB ONNX pack) plus the ONNX Kokoro model.
- **Russian** is handled internally by [Vosk-TTS](https://github.com/alphacep/vosk-tts) — text normalisation, stress, palatalisation, and a BERT prosody model all run inside the bundled ONNX (no separate G2P pass, no system `espeak-ng` dependency).
- **Other languages**: not supported by the on-disk engines we ship today — tracked per-language in [#212](https://github.com/drakulavich/kesha-voice-kit/issues/212).

Default voices are **male**, because Kesha is a male name: `en-am_michael` for English Kokoro, `ru-vosk-m02` for Russian Vosk on Linux/Windows. The darwin Russian fallback uses `Milena` (AVSpeech, female) for the zero-install path; pass `--voice ru-vosk-m02` to opt into Vosk on macOS too.

**Supported voices:**
- English: `en-am_michael` (default). Darwin FluidAudio builds expose the supported FluidAudio Kokoro English voices via `kesha say --list-voices`; ONNX builds also see any `.bin` voice you add under `~/.cache/kesha/models/kokoro-82m/voices/`.
- Apple Silicon Kokoro multilingual voices: `es-em_alex`, `hi-hm_omega`, `it-im_nicola`, `ja-jm_kumo`, `pt-pm_alex`, `zh-zm_050`, and `fr-ff_siwis`. The Spanish, Hindi, Italian, Japanese, Portuguese, and Chinese defaults are male; French auto-routes to `fr-ff_siwis` (female) because upstream Kokoro ships no native male French voice.
- Russian: 5 Vosk-TTS speakers baked into the multi-speaker model — `ru-vosk-m02` (default, male), `ru-vosk-m01` (male), `ru-vosk-f01`/`f02`/`f03` (female).
- macOS system voices: `macos-<identifier-or-language>`, see [below](#macos-system-voices).

### Where the files live

On Linux and Windows the TTS models land in Kesha's model cache. On darwin-arm64, `kesha install --tts` downloads the FluidAudio Kokoro files, checks each against its pinned SHA-256, and stages them where FluidAudio reads them, outside Kesha's model cache because FluidAudio resolves no other path. The first synthesis compiles them and downloads nothing ([#823](https://github.com/drakulavich/kesha-voice-kit/issues/823), [#856](https://github.com/drakulavich/kesha-voice-kit/issues/856)). The CoreML Kokoro bundles live under `<cache>/fluidaudio/kokoro-82m-coreml/`, or stay in FluidAudio's own `~/.cache/fluidaudio/Models/kokoro-82m-coreml/` on an install that already had them ([#688](https://github.com/drakulavich/kesha-voice-kit/issues/688)); the G2P assets beside them at `~/.cache/fluidaudio/Models/kokoro` never move, because upstream pins that path. `kesha install --plan --tts` prints the paths and sizes for your machine.

## macOS system voices

`kesha say --voice macos-*` routes through `AVSpeechSynthesizer` on macOS, so you get voice synthesis with no model download, from any of the 180+ voices already on your Mac. The sidecar binary ships alongside `kesha-engine` on darwin-arm64 releases ([#141](https://github.com/drakulavich/kesha-voice-kit/issues/141)); `kesha install` places both in `~/.cache/kesha/bin/`.

```bash
kesha say --list-voices | grep ^macos-                                       # discover installed voices
kesha say --voice macos-com.apple.voice.compact.en-US.Samantha "Hello" > out.wav
kesha say --voice macos-ru-RU "Привет, мир" > hello-ru.wav                   # language-code fallback
```

Voice id format: `macos-<id>` where `<id>` is either a full Apple identifier (`com.apple.voice.compact.en-US.Samantha`) or a language code (`en-US`, `ru-RU`) — the Swift helper tries the identifier first and falls back to the language. Output is mono float32, structurally identical to Vosk; the sample rate is whatever the chosen system voice renders at (22050 Hz for the legacy voices, 16000 Hz for the Eloquence set).

macOS system voices are notification-grade. Use them when you want zero-install TTS on macOS; keep Kokoro/Vosk for anything that needs to sound good.

## English acronym auto-expansion

For `en-*` (Kokoro) voices, `kesha say` auto-expands all-uppercase Latin acronyms into a pronunciation Kokoro can render. Three cooperating tables pick the right path per token:

```bash
kesha say --voice en-am_michael 'The FBI is investigating.'
# audible: "The ef-bee-eye is investigating."

kesha say --voice en-am_michael 'EPAM partners with Anthropic.'
# audible: "EE-pam partners with an-THROP-ik."  (IPA injection bypasses G2P)

kesha say --voice en-am_michael 'Send JSON over HTTP.'
# audible: "Send JAY-son over aitch-tee-tee-pee."  (mixed: IPA + letter-spell)

kesha say --voice en-am_michael --no-expand-abbrev 'EPAM ...'
# IPA hits still fire (intent-explicit, parallel to <say-as>); letter-spell rule disabled.
```

- **Letter-spell rule** — uppercase Latin tokens 2–5 chars not on the stop-list and not in the lexicon get expanded letter-by-letter via the embedded letter-name table. Disable per call with `--no-expand-abbrev`.
- **`STOP_LIST`** (30 entries) — natural-English caps words pass through verbatim: `NASA`, `NATO`, `AIDS`, `OPEC`, `IKEA`, `ASCII`, `NAFTA`, `LASER`, `RADAR`, `SCUBA`, plus 20 emphatic length-2 caps (`OK`, `IT`, `IS`, …).
- **`IPA_LEXICON`** (19 entries) — case-sensitive token → IPA-phoneme map; hits emit a `Segment::Ipa` and bypass G2P entirely. Covers industry-pronunciation acronyms (`EPAM` /ˈiːpæm/, `JSON` /ˈdʒeɪsən/, `JPEG`, `GIF`, `SQL`, `ASAP`, `CRUD`, `JWT`, `OAuth`) AND mixed-case proper nouns (`Anthropic` /ænθɹˈɑpɪk/, `Microsoft`, `Claude`, `Kubernetes`, `PostgreSQL`, `GraphQL`, `Linux`, `Tokio`, `macOS`, `Granola`). IPA hits fire even with `--no-expand-abbrev`. Darwin FluidAudio builds phonemize text themselves, so the whole table is installed into their lexicon instead ([#818](https://github.com/drakulavich/kesha-voice-kit/issues/818)). `Kubernetes`, `Tokio`, `macOS` and `Anthropic` carry FluidAudio's own G2P output verbatim, so both engines say them the same way ([#846](https://github.com/drakulavich/kesha-voice-kit/issues/846)).

`<say-as interpret-as="characters">…</say-as>` always wins — letter-spells via the embedded table regardless of `--no-expand-abbrev`. Engine lists `tts.en_acronym_expansion` in `describe` ([#244](https://github.com/drakulavich/kesha-voice-kit/issues/244)).

### Where `--no-expand-abbrev` actually applies

The flag is accepted on every voice, but only two paths can act on it — the rest spell initialisms inside an engine-owned G2P with no opt-out, and warn on stderr instead of ignoring the request in silence ([#842](https://github.com/drakulavich/kesha-voice-kit/issues/842)).

| Voice | Engine | `--no-expand-abbrev` |
| --- | --- | --- |
| `ru-vosk-*` (every build) | Vosk-TTS | **honored** — suppresses the Cyrillic letter-spell rule ([#232](https://github.com/drakulavich/kesha-voice-kit/issues/232)) |
| `en-*` on ONNX builds (Linux, Windows, macOS without `system_kokoro`) | ONNX Kokoro | **honored** — suppresses the letter-spell rule; `IPA_LEXICON` hits still fire |
| `en-*` on the released darwin-arm64 build | FluidAudio Kokoro (ANE) | no-op — upstream `EnglishInitialisms` spells `FBI`/`IBM` in its own G2P and exposes no suppression knob. Per-word overrides go through the lexicon binding ([#818](https://github.com/drakulavich/kesha-voice-kit/issues/818)), which wins ahead of the initialism rule |
| `es`/`fr`/`it`/`pt` on ONNX builds | ONNX Kokoro + CharsiuG2P | no-op — the Romance normalizer runs unconditionally inside G2P, before the segment pipeline that reads the flag |
| `es`/`fr`/`it`/`pt`/`hi`/`ja`/`zh` on darwin-arm64 | FluidAudio Kokoro | no-op |
| `macos-*` | AVSpeech | no-op — the Swift sidecar owns normalization |

Because the released macOS binary compiles `system_kokoro`, the same `kesha say --voice en-am_michael --no-expand-abbrev` suppresses spelling on Linux and does not on an Apple Silicon Mac. The engine says so on stderr; audio is byte-identical either way there.

## Russian abbreviation auto-expansion

For `ru-vosk-*` voices, `kesha say` detects all-uppercase Cyrillic acronyms (length 2–5) and reads them letter-by-letter when the token cannot be pronounced as a natural Russian syllable:

```bash
kesha say --voice ru-vosk-m02 'ФСБ объявила.'      # audible: "эф эс бэ объявила"
kesha say --voice ru-vosk-m02 'ВОЗ предупреждает.' # audible: "воз предупреждает" (CVC alternation passes through)
kesha say --voice ru-vosk-m02 'ОН пришёл.'         # audible: "ОН пришёл" (stop-list)
```

The rule fires when the token is length ≤ 2 (`ИП` → "и пэ"), has 0 vowels (`ФСБ` → "эф эс бэ"), or has 2+ consecutive vowels / consonants (`ОАЭ` → "о а э", `США` → "сэ шэ а"). Tokens with strict CVC/CVCV alternation pass through (`ВОЗ`, `НАТО`, `ОПЕК`). Letter-name forms tuned to user-validated Vosk pronunciation: `Ф` → "эф", `Ш` → "шэ", `Л` → "эл", `С` → "сэ" at start / "эс" elsewhere. Stop-list of ~25 common short words (`ОН`, `МЫ`, `КАК`, `ЧТО`, …) prevents false positives. Tokens containing `Ъ`/`Ь` are passed through literally.

Opt-out per call with `--no-expand-abbrev`. `<say-as interpret-as="characters">…</say-as>` always wins. Engine reports `tts.ru_acronym_expansion: true` ([#232](https://github.com/drakulavich/kesha-voice-kit/issues/232)).

## Russian numbers

Vosk's G2P has no reading for digits and drops them without a sound (`Кабинет 405.` would come out as `Кабинет.`), so for `ru-vosk-*` voices Kesha rewrites every number to words before synthesis:

```bash
kesha say --voice ru-vosk-m02 'Встреча 25 декабря 2026 года, в 14:30, кабинет 405.'
# audible: "…двадцать пятого декабря две тысячи двадцать шестого года, в четырнадцать тридцать, кабинет четыреста пять"
```

Russian numerals decline, and the engine only claims the cases it can read off the neighbouring word: a day before a genitive month (`25 декабря` → «двадцать пятого»), a year before `год`/`года`/`году` (`2026 года` → «две тысячи двадцать шестого»), and `HH:MM` clock times. Everything else is a nominative cardinal, so `в 405 кабинете` is spoken «в четыреста пять кабинете» — the wrong case, but audible.

Below 1000, `N год`/`N года` reads as a **duration** and keeps its cardinal (`2 года` → «два года», `21 год` → «двадцать один год») — that is already the correct form, and treating it as a year would break it. Prepositional `году` is exempt from the cut because a duration never takes it, so historical years still work (`в 988 году` → «в девятьсот восемьдесят восьмом году»). The date and year agreement is read within a single text run, so SSML that splits `25` from `декабря` across segments falls back to nominative. Decimals and ranges read their digit groups separately (`3,5` → «три,пять», `10-15` → «десять-пятнадцать»), runs of ten digits or more read digit-by-digit (phone numbers, ids), and `<say-as interpret-as="characters">405</say-as>` reads «четыре ноль пять».

This is not an abbreviation feature: `--no-expand-abbrev` suppresses letter-spelling only, never number verbalization ([#891](https://github.com/drakulavich/kesha-voice-kit/issues/891)).

## SSML

`kesha say --ssml` accepts a subset of [SSML](https://www.w3.org/TR/speech-synthesis11/):

```bash
kesha say --ssml '<speak>Hello <break time="500ms"/> world.</speak>'
kesha say --ssml --voice ru-vosk-m02 '<speak>Привет <break time="1s"/> мир.</speak>'
```

| Tag | Status |
|---|---|
| `<speak>` | ✅ required root: exactly one, closed, with every tag inside it closed and nothing but whitespace, comments, or processing instructions after `</speak>` (else `E_SSML_INVALID`) |
| `<break time="Nms"\|"Ns"\|default>` | ✅ inserts silence of the given duration, at most 30 s per break (a longer one is capped with a warning) |
| plain text inside `<speak>` | ✅ synthesized via the selected engine |
| `<say-as interpret-as="characters">…</say-as>` | ✅ honored on `ru-vosk-*` (#232) and ONNX `en-*` (#244) — letter-spells via the embedded table; read as plain text with a stderr warning on Darwin FluidAudio Kokoro; AVSpeech rejects every SSML request with `E_SSML_UNSUPPORTED` |
| `<say-as interpret-as="cardinal\|ordinal\|date\|telephone\|...">` | ⚠️ stripped with stderr warning (contained text still synthesized); separate concern |
| `<emphasis>` | ✅ honored on `ru-vosk-*` (#233) — `+vowel` markers shift stress; `level="none"` suppresses. Stripped + warned on Kokoro (no `+`-marker analog); AVSpeech rejects every SSML request with `E_SSML_UNSUPPORTED` |
| `<phoneme alphabet="ipa" ph="…">` | ✅ honored on ONNX Kokoro — bypasses G2P, feeds IPA directly to inference (#193). Darwin FluidAudio Kokoro has no IPA input: the tag is stripped with one warning and the wrapped text is spoken. |
| `<prosody rate>` | ✅ honored on `ru-vosk-*`, ONNX Kokoro and Darwin FluidAudio Kokoro voices when wrapping the whole utterance — see [Speech rate](#speech-rate-prosody-rate) (#236). Mid-utterance / sibling-flanked: warned + stripped. |
| `<prosody pitch/volume>` | ⚠️ stripped with stderr warning; tracked in [#236](https://github.com/drakulavich/kesha-voice-kit/issues/236) |
| `<!DOCTYPE>` | ❌ rejected (hardening against XXE) |

SSML is opt-in via the explicit `--ssml` flag — inputs that happen to contain `<angle brackets>` aren't misinterpreted as SSML.

## Russian word stress (`<emphasis>`)

For `ru-vosk-*` voices, `<emphasis>` lets you place the stress on a specific vowel by prepending `+` to it. Vosk-TTS honors the marker as a stress hint when it shifts stress AWAY from the model's default first-syllable behavior:

```bash
kesha say --voice ru-vosk-m02 --ssml \
  '<speak><emphasis>дом+а</emphasis></speak>'  # genitive до-МА́
kesha say --voice ru-vosk-m02 --ssml \
  '<speak><emphasis level="none">дом+а</emphasis></speak>'  # default ДО́ма (suppress)
```

Once-per-process stderr warning fires when `<emphasis>` content lacks any `+` marker. `<emphasis>` on Kokoro voices strips `+` and warns once (Kokoro has no `+`-marker analog); AVSpeech rejects every SSML request with `E_SSML_UNSUPPORTED`. Engine reports `tts.ru_emphasis_marker: true` ([#233](https://github.com/drakulavich/kesha-voice-kit/issues/233)).

## Speech rate (`<prosody rate>`)

Honored on `ru-vosk-*` (Vosk-TTS) and every Kokoro voice (ONNX and darwin FluidAudio) when the `<prosody>` element wraps the WHOLE utterance:

```bash
kesha say --voice ru-vosk-m02 --ssml \
  '<speak><prosody rate="slow">Привет, как дела.</prosody></speak>' --out slow.wav

kesha say --voice en-am_michael --ssml \
  '<speak><prosody rate="120%">Read this slightly fast.</prosody></speak>' --out fast.wav
```

**Supported values** (W3C SSML 1.1 rate attribute):

| Form | Examples | Effective multiplier |
|---|---|---|
| Named | `x-slow` `slow` `medium` `fast` `x-fast` `default` | 0.5 / 0.75 / 1.0 / 1.25 / 1.5 / 1.0 |
| Absolute percent | `100%` `150%` `200%` | `N / 100` |

Range clamped to 0.5×–2.0×; values outside the range are clamped silently. `--rate <float>` (CLI flag) and `<prosody rate>` (SSML) compose multiplicatively — final speed = `cli_rate × ssml_rate`, then clamped.

**Not supported yet:**
- Relative percent (`+25%` / `-25%`) is NOT supported. The upstream `ssml-parser` strips the sign on parse, so `+N%` would silently produce the absolute `N%` rate. `kesha say --ssml` rejects relative-percent input with a clear error pointing users at absolute percent or named values. Tracked in [#236](https://github.com/drakulavich/kesha-voice-kit/issues/236).
- Mid-utterance prosody (`<speak>Hi <prosody rate="fast">there</prosody> bye</speak>`) emits a `prosody-mid-utterance` stderr warning and synthesizes the full text at default rate. A leading or trailing structural sibling (`<break/>`, `<say-as>`, `<phoneme>`) outside the `<prosody>` also triggers the mid-utterance path. Per-segment splitting first needs a check that boundary cuts don't click or pop ([#236](https://github.com/drakulavich/kesha-voice-kit/issues/236)).
- Nested `<prosody>` warns once (`prosody-nested`) and drops the inner attributes; inner content flows at the outer rate.
- AVSpeech (`macos-*`) voices don't accept SSML; `--ssml` errors out with `E_SSML_UNSUPPORTED` before any prosody handling runs. Darwin FluidAudio Kokoro (`en-*` and the other Kokoro languages on darwin-arm64) honours `<break>` and whole-utterance `<prosody rate>`; `<say-as characters>` and `<phoneme>` are read as their plain text there, with one warning each.
- `<prosody pitch>` and `<prosody volume>` warn once and are stripped ([#236](https://github.com/drakulavich/kesha-voice-kit/issues/236)).

Engine lists `tts.prosody_rate` in `describe` ([#236](https://github.com/drakulavich/kesha-voice-kit/issues/236)).
