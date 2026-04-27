# Text-to-Speech

Kesha speaks back via Kokoro-82M (English) and Piper (Russian). Voice is auto-picked from the input text's language — `en` routes to Kokoro, `ru` to Piper. Pass `--voice` to override.

```bash
kesha install --tts                 # ~490MB (Kokoro + Piper RU + ONNX G2P, opt-in)
kesha say "Hello, world" > hello.wav
kesha say "Привет, мир" > privet.wav    # auto-routes to ru-denis
echo "long text" | kesha say > reply.wav
kesha say --out reply.wav "text"
kesha say --voice en-af_heart "text"    # explicit voice overrides auto-routing
kesha say --list-voices
```

Output format: WAV mono float32 (24 kHz for Kokoro, 22.05 kHz for Piper). OGG/Opus and MP3 are tracked in follow-up issues.

Grapheme-to-phoneme: English uses [misaki-rs](https://github.com/MicheleYin/misaki-rs) — a self-contained Rust port of [hexgrad/misaki](https://github.com/hexgrad/misaki) (the G2P Kokoro was trained against). Lexicon and POS-tagger weights are embedded at compile time, no system deps. Out-of-vocabulary words (proper nouns, technical jargon) currently spell letter-by-letter — `espeak-ng` fallback for OOV is tracked as a follow-up. Other languages (Russian via Piper) currently use the older CharsiuG2P ByT5-tiny ONNX path ([#123](https://github.com/drakulavich/kesha-voice-kit/issues/123)) — replacement tracked per-language ([#210](https://github.com/drakulavich/kesha-voice-kit/issues/210) for `ru`).

**Supported voices:**
- English: `en-af_heart` (default), plus any Kokoro voice you download into `~/.cache/kesha/models/kokoro-82m/voices/`
- Russian: `ru-denis` (default). More speakers (dmitri, irina, ruslan) are ready to drop in once needed.
- macOS system voices: `macos-<identifier-or-language>` routes to `AVSpeechSynthesizer`. Zero install, any of the 180+ voices already on your Mac.

## macOS system voices

`kesha say --voice macos-*` routes through `AVSpeechSynthesizer` on macOS, so you get voice synthesis for free — no 490 MB TTS bundle. The sidecar binary ships alongside `kesha-engine` on darwin-arm64 releases ([#141](https://github.com/drakulavich/kesha-voice-kit/issues/141)); `kesha install` places both in `~/.cache/kesha/bin/`.

```bash
kesha say --list-voices | grep ^macos-                                       # discover installed voices
kesha say --voice macos-com.apple.voice.compact.en-US.Samantha "Hello" > out.wav
kesha say --voice macos-ru-RU "Привет, мир" > hello-ru.wav                   # language-code fallback
```

Voice id format: `macos-<id>` where `<id>` is either a full Apple identifier (`com.apple.voice.compact.en-US.Samantha`) or a language code (`en-US`, `ru-RU`) — the Swift helper tries the identifier first and falls back to the language. Output is mono float32 @ 22050 Hz, structurally identical to Piper.

Quality tradeoff is honest: macOS system voices are notification-grade. Use them when you want zero-install TTS on macOS; keep Kokoro/Piper for anything that needs to sound good.

## SSML (preview)

`kesha say --ssml` accepts [SSML](https://www.w3.org/TR/speech-synthesis11/) for pauses and text-structuring. v1 is deliberately small:

```bash
kesha say --ssml '<speak>Hello <break time="500ms"/> world.</speak>'
kesha say --ssml --voice ru-denis '<speak>Привет <break time="1s"/> мир.</speak>'
```

| Tag | Status |
|---|---|
| `<speak>` | ✅ required root |
| `<break time="Nms"\|"Ns"\|default>` | ✅ inserts silence of the given duration |
| plain text inside `<speak>` | ✅ synthesized via the selected engine |
| `<emphasis>`, `<prosody>`, `<phoneme>`, `<say-as>` | ⚠️ stripped with a stderr warning (contained text still synthesized); tracked in [#122](https://github.com/drakulavich/kesha-voice-kit/issues/122) |
| `<!DOCTYPE>` | ❌ rejected (hardening against XXE) |

SSML is opt-in via the explicit `--ssml` flag — inputs that happen to contain `<angle brackets>` aren't misinterpreted as SSML.
