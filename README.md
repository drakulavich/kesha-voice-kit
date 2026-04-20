<p align="center">
  <img src="assets/logo.png" alt="Kesha Voice Kit" width="200">
</p>

<h1 align="center">Kesha Voice Kit</h1>

<p align="center">
  <a href="https://github.com/drakulavich/kesha-voice-kit/actions/workflows/ci.yml"><img src="https://github.com/drakulavich/kesha-voice-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@drakulavich/kesha-voice-kit"><img src="https://img.shields.io/npm/v/@drakulavich/kesha-voice-kit" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun"></a>
</p>

<p align="center"><b>Open-source voice toolkit.</b> Optimized for Apple Silicon (CoreML), works on any platform (ONNX fallback).<br>A collection of small, fast, open-source audio models — packaged as CLI tools and an <a href="https://github.com/openclaw/openclaw">OpenClaw</a> skill for LLM agents.</p>

- **Speech-to-text** — 25 languages, ~15x faster than Whisper on Apple Silicon, ~2.5x on CPU
- **Language detection** — 107 languages from audio, text language via NLLanguageRecognizer
- **Rust engine** — single 20MB binary, no ffmpeg, no Python, no native Node addons
- **OpenClaw-ready** — plug into your LLM agent as a voice processing skill

## Quick Start

Runtime: **[Bun](https://bun.sh)** >= 1.3.0.

```bash
curl -fsSL https://bun.sh/install | bash   # skip if Bun is already installed

bun install -g @drakulavich/kesha-voice-kit
kesha install       # downloads engine + models
kesha audio.ogg     # transcript to stdout
```

## OpenClaw Integration

Kesha Voice Kit ships as a plugin for [OpenClaw](https://github.com/openclaw/openclaw) — give your LLM agent ears. No API keys, everything runs locally on your machine.

```bash
bun add -g @drakulavich/kesha-voice-kit && kesha install
openclaw plugins install @drakulavich/kesha-voice-kit
openclaw config set tools.media.audio.models \
  '[{"type":"cli","command":"kesha","args":["--format","transcript","{{MediaPath}}"],"timeoutSeconds":15}]'
```

> If audio transcription is not already enabled: `openclaw config set tools.media.audio.enabled true`

Your agent receives a voice message in Telegram/WhatsApp/Slack, Kesha transcribes it locally, and the agent sees enriched context:

```
Таити, Таити! Не были мы ни в какой Таити! Нас и тут неплохо кормят.
[lang: ru, confidence: 1.00]
```

Manage the plugin with `openclaw plugins list`, `openclaw plugins disable kesha-voice-kit`, or `openclaw plugins uninstall kesha-voice-kit`.

## CLI Tools

```bash
kesha install                              # download engine and models
kesha audio.ogg                            # transcribe (plain text)
kesha --format transcript audio.ogg        # text + language/confidence
kesha --format json audio.ogg              # full JSON with lang fields
kesha --json audio.ogg                     # alias for --format json
kesha --verbose audio.ogg                  # show language detection details
kesha --lang en audio.ogg                  # warn if detected language differs
kesha status                               # show installed backend info
```

Multiple files — headers per file, like `head`:

```bash
$ kesha freedom.ogg tahiti.ogg
=== freedom.ogg ===
Свободу попугаям! Свободу!

=== tahiti.ogg ===
Таити, Таити! Не были мы ни в какой Таити! Нас и тут неплохо кормят.
```

Stdout: transcript. Stderr: errors. Pipe-friendly. Also available as `parakeet` command (backward-compatible alias).

## Text-to-Speech

Kesha speaks back via Kokoro-82M (English) and Piper (Russian). Voice is auto-picked from the input text's language — `en` routes to Kokoro, `ru` to Piper. Pass `--voice` to override.

```bash
brew install espeak-ng              # one-time system dep — macOS
# Linux:   sudo apt install espeak-ng
# Windows: choco install espeak-ng  (puts libespeak-ng.dll on PATH)
kesha install --tts                 # ~390MB (Kokoro + Piper RU, opt-in)
kesha say "Hello, world" > hello.wav
kesha say "Привет, мир" > privet.wav    # auto-routes to ru-denis
echo "long text" | kesha say > reply.wav
kesha say --out reply.wav "text"
kesha say --voice en-af_heart "text"    # explicit voice overrides auto-routing
kesha say --list-voices
```

Output format: WAV mono float32 (24 kHz for Kokoro, 22.05 kHz for Piper). OGG/Opus and MP3 are tracked in follow-up issues. Static-linking of `espeak-ng` to remove the system dep is [#124](https://github.com/drakulavich/kesha-voice-kit/issues/124).

**Supported voices:**
- English: `en-af_heart` (default), plus any Kokoro voice you download into `~/.cache/kesha/models/kokoro-82m/voices/`
- Russian: `ru-denis` (default). More speakers (dmitri, irina, ruslan) are ready to drop in once needed.
- macOS system voices: `macos-<identifier-or-language>` routes to `AVSpeechSynthesizer`. Zero install, any of the 180+ voices already on your Mac.

### macOS system voices

`kesha say --voice macos-*` routes through `AVSpeechSynthesizer` on macOS, so you get voice synthesis for free — no 390 MB TTS bundle, no `espeak-ng` dep. The sidecar binary ships alongside `kesha-engine` on darwin-arm64 releases (#141); `kesha install` places both in `~/.cache/kesha/bin/`.

```bash
kesha say --list-voices | grep ^macos-                                       # discover installed voices
kesha say --voice macos-com.apple.voice.compact.en-US.Samantha "Hello" > out.wav
kesha say --voice macos-ru-RU "Привет, мир" > hello-ru.wav                   # language-code fallback
```

Voice id format: `macos-<id>` where `<id>` is either a full Apple identifier (`com.apple.voice.compact.en-US.Samantha`) or a language code (`en-US`, `ru-RU`) — the Swift helper tries the identifier first and falls back to the language. Output is mono float32 @ 22050 Hz, structurally identical to Piper.

Quality tradeoff is honest: macOS system voices are notification-grade. Use them when you want zero-install TTS on macOS; keep Kokoro/Piper for anything that needs to sound good.

### SSML (preview)

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

## What's Inside

Kesha Voice Kit bundles open-source models optimized for on-device inference:

| Model | Task | Size | Source |
|---|---|---|---|
| NVIDIA Parakeet TDT 0.6B v3 | Speech-to-text | ~2.5GB | [HuggingFace](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| SpeechBrain ECAPA-TDNN | Audio language detection | ~86MB | [HuggingFace](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa) |
| Apple NLLanguageRecognizer | Text language detection | built-in | macOS system framework |

All models run through `kesha-engine` — a Rust binary using [FluidAudio](https://github.com/FluidInference/FluidAudio) (CoreML) on Apple Silicon and [ort](https://github.com/pykeio/ort) (ONNX Runtime) on other platforms.

## Performance

> **~15x faster than Whisper** on Apple Silicon (M3 Pro), **~2.5x faster** on CPU

Compared against Whisper `large-v3-turbo` — all engines auto-detect language.

![Benchmark: openai-whisper vs faster-whisper vs Kesha Voice Kit](assets/benchmark.svg)

<details>
<summary>Full results with per-file breakdown</summary>

See [BENCHMARK.md](BENCHMARK.md) — includes Russian (real voice messages) and English transcription results with all four engines.

</details>

## Supported Audio Formats

Built-in audio decoding via [symphonia](https://github.com/pdeljanov/Symphonia) — no ffmpeg required:

| Format | Extension |
|---|---|
| WAV | `.wav` |
| MP3 | `.mp3` |
| OGG Vorbis/Opus | `.ogg`, `.opus` |
| FLAC | `.flac` |
| AAC / M4A | `.aac`, `.m4a` |

## Supported Languages

**Speech-to-text (25):** :bulgaria: Bulgarian, :croatia: Croatian, :czech_republic: Czech, :denmark: Danish, :netherlands: Dutch, :gb: English, :estonia: Estonian, :finland: Finnish, :fr: French, :de: German, :greece: Greek, :hungary: Hungarian, :it: Italian, :latvia: Latvian, :lithuania: Lithuanian, :malta: Maltese, :poland: Polish, :portugal: Portuguese, :romania: Romanian, :ru: Russian, :slovakia: Slovak, :slovenia: Slovenian, :es: Spanish, :sweden: Swedish, :ukraine: Ukrainian

**Audio language detection (107):** Full list at [speechbrain/lang-id-voxlingua107-ecapa](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa)

## Architecture

```
kesha audio.ogg
  → kesha-engine (Rust binary)
    ├── Apple Silicon? → FluidAudio (CoreML / Neural Engine)
    └── Other?        → ort (ONNX Runtime / CPU)
  → transcript to stdout
```

## Programmatic API

```typescript
import { transcribe, downloadModel } from "@drakulavich/kesha-voice-kit/core";

await downloadModel();                    // install engine + models
const text = await transcribe("audio.ogg"); // transcribe
```

## Requirements

- [Bun](https://bun.sh) >= 1.3
- macOS arm64, Linux x64, or Windows x64

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Made with 💛🩵 and 🥤 energy under MIT License
