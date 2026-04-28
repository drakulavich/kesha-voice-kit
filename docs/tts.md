# Text-to-Speech

Kesha speaks back via Kokoro-82M (English) and Vosk-TTS (Russian). Voice is auto-picked from the input text's language — `en` routes to Kokoro, `ru` to Vosk. Pass `--voice` to override.

```bash
kesha install --tts                 # ~990MB (Kokoro + Vosk-TTS RU, opt-in)
kesha say "Hello, world" > hello.wav
kesha say "Привет, мир" > privet.wav    # auto-routes (Milena on darwin, ru-vosk-m02 elsewhere)
echo "long text" | kesha say > reply.wav
kesha say --out reply.wav "text"
kesha say --voice en-am_michael "text"    # explicit voice overrides auto-routing
kesha say --list-voices
```

Output format: WAV mono float32 (24 kHz for Kokoro, 22.05 kHz for Vosk). OGG/Opus and MP3 are tracked in follow-up issues.

Grapheme-to-phoneme:
- **English** uses [misaki-rs](https://github.com/MicheleYin/misaki-rs) — a self-contained Rust port of [hexgrad/misaki](https://github.com/hexgrad/misaki) (the G2P Kokoro was trained against). Lexicon and POS-tagger weights are embedded at compile time, no system deps. Out-of-vocabulary words spell letter-by-letter — proper-noun fallback is tracked as a follow-up.
- **Russian** is handled internally by [Vosk-TTS](https://github.com/alphacep/vosk-tts) — text normalisation, stress, palatalisation, and a BERT prosody model all run inside the bundled ONNX (no separate G2P pass, no system `espeak-ng` dependency).
- **Other languages**: not supported by the on-disk engines we ship today — tracked per-language in [#212](https://github.com/drakulavich/kesha-voice-kit/issues/212).

Default voices are **male** per CLAUDE.md "DEFAULT TTS VOICES MUST BE MALE": `am_michael` for English Kokoro, `ru-vosk-m02` for Russian Vosk on Linux/Windows. The darwin Russian fallback uses `Milena` (AVSpeech, female) for the zero-install path; pass `--voice ru-vosk-m02` to opt into Vosk on macOS too.

**Supported voices:**
- English: `en-am_michael` (default), plus any Kokoro voice you download into `~/.cache/kesha/models/kokoro-82m/voices/` (`am_*`/`bm_*` male, `af_*`/`bf_*` female).
- Russian: 5 Vosk-TTS speakers baked into the multi-speaker model — `ru-vosk-m02` (default, male), `ru-vosk-m01` (male), `ru-vosk-f01`/`f02`/`f03` (female).
- macOS system voices: `macos-<identifier-or-language>` routes to `AVSpeechSynthesizer`. Zero install, any of the 180+ voices already on your Mac.

## macOS system voices

`kesha say --voice macos-*` routes through `AVSpeechSynthesizer` on macOS, so you get voice synthesis for free — no 490 MB TTS bundle. The sidecar binary ships alongside `kesha-engine` on darwin-arm64 releases ([#141](https://github.com/drakulavich/kesha-voice-kit/issues/141)); `kesha install` places both in `~/.cache/kesha/bin/`.

```bash
kesha say --list-voices | grep ^macos-                                       # discover installed voices
kesha say --voice macos-com.apple.voice.compact.en-US.Samantha "Hello" > out.wav
kesha say --voice macos-ru-RU "Привет, мир" > hello-ru.wav                   # language-code fallback
```

Voice id format: `macos-<id>` where `<id>` is either a full Apple identifier (`com.apple.voice.compact.en-US.Samantha`) or a language code (`en-US`, `ru-RU`) — the Swift helper tries the identifier first and falls back to the language. Output is mono float32 @ 22050 Hz, structurally identical to Vosk.

Quality tradeoff is honest: macOS system voices are notification-grade. Use them when you want zero-install TTS on macOS; keep Kokoro/Vosk for anything that needs to sound good.

## SSML (preview)

`kesha say --ssml` accepts [SSML](https://www.w3.org/TR/speech-synthesis11/) for pauses and text-structuring. v1 is deliberately small:

```bash
kesha say --ssml '<speak>Hello <break time="500ms"/> world.</speak>'
kesha say --ssml --voice ru-vosk-m02 '<speak>Привет <break time="1s"/> мир.</speak>'
```

| Tag | Status |
|---|---|
| `<speak>` | ✅ required root |
| `<break time="Nms"\|"Ns"\|default>` | ✅ inserts silence of the given duration |
| plain text inside `<speak>` | ✅ synthesized via the selected engine |
| `<emphasis>`, `<prosody>`, `<phoneme>`, `<say-as>` | ⚠️ stripped with a stderr warning (contained text still synthesized); tracked in [#122](https://github.com/drakulavich/kesha-voice-kit/issues/122) |
| `<!DOCTYPE>` | ❌ rejected (hardening against XXE) |

SSML is opt-in via the explicit `--ssml` flag — inputs that happen to contain `<angle brackets>` aren't misinterpreted as SSML.
