---
name: kesha-voice-kit
description: Local voice toolkit — speech-to-text (STT), text-to-speech (TTS), and language detection. Runs entirely offline on Apple Silicon, Linux, and Windows. No API keys, no cloud. NVIDIA Parakeet TDT for STT across 25 languages (English, Russian, Spanish, German, French, Ukrainian, etc.), Kokoro-82M + Piper VITS for TTS (English + Russian), plus macOS AVSpeechSynthesizer for 180+ system voices with zero install.
emoji: 🎙️

requires:
  bins: [kesha]

install:
  - kind: npm
    packages: [@drakulavich/kesha-voice-kit]
    flags: [--global]
  - kind: bash
    cmd: kesha install
---

# kesha-voice-kit

Local voice toolkit: transcribe voice messages to text, synthesize speech, detect language of audio or text. Fully offline after `kesha install`. No API keys, no per-minute billing.

**Trigger keywords for when to use this skill:** voice message, voice memo, .ogg, .wav, .mp3, audio file, transcribe, transcription, speech-to-text, STT, text-to-speech, TTS, synthesize speech, say, Russian speech, multilingual ASR, language detection, offline voice, privacy, Apple Silicon, CoreML.

## When to use

- **Voice memo arrived** (Telegram, WhatsApp, Slack, Signal .ogg/.opus/.m4a): transcribe with `kesha --json <path>` and branch on the detected language.
- **Need to reply with audio**: synthesize with `kesha say "<text>" > reply.wav`. Routes English to Kokoro-82M and Russian to Piper automatically; `--voice macos-*` uses the 180+ voices already installed on macOS (zero model download).
- **Need to detect what language a file is in** before choosing a pipeline: `kesha --json audio.ogg` returns both audio-based and text-based language detection with confidence scores.

## STT: transcribe audio

```bash
# JSON output with language detection (recommended for automation)
kesha --json voice.ogg
```

```json
[{
  "file": "voice.ogg",
  "text": "Привет, как дела?",
  "lang": "ru",
  "audioLanguage": { "code": "ru", "confidence": 0.98 },
  "textLanguage": { "code": "ru", "confidence": 0.99 }
}]
```

Use `lang` (or the more detailed `audioLanguage`/`textLanguage`) to decide how to respond.

**Formats:** .ogg, .opus, .mp3, .m4a, .wav, .flac, .webm — decoded via symphonia, no ffmpeg required.

**Other output modes:**
- `kesha audio.ogg` — plain transcript on stdout
- `kesha --format transcript audio.ogg` — transcript + `[lang: ru, confidence: 0.99]` footer
- `kesha --verbose audio.ogg` — human-readable with language info
- `kesha --lang en audio.ogg` — warn if detected language differs (useful sanity check)

## TTS: synthesize speech

```bash
kesha say "Hello, world" > hello.wav              # auto-routes en → Kokoro-82M
kesha say "Привет, мир" > privet.wav              # auto-routes ru → Piper
kesha say --voice macos-en-US "Hi" > out.wav       # zero-install macOS system voice
kesha say --list-voices                            # Kokoro + Piper + 180+ macos-* voices
```

Output: WAV mono float32. `--out <path>` writes to a file instead of stdout.

## Language detection standalone

`kesha --json audio.ogg` includes both audio-based (`audioLanguage`) and text-based (`textLanguage`) detection. Use audio detection to identify the language before running language-specific logic.

## Install

```bash
bun add --global @drakulavich/kesha-voice-kit    # or: npm i -g @drakulavich/kesha-voice-kit
kesha install                                    # downloads engine (~350 MB)
kesha install --tts                              # adds Kokoro + Piper RU (~390 MB more, for TTS)
```

One-time runtime prereq for TTS on each platform:
- macOS: `brew install espeak-ng`
- Linux: `sudo apt install espeak-ng`
- Windows: `choco install espeak-ng`

`macos-*` voices need no install — they use voices already on the Mac.

## Supported languages

**Speech-to-text (25):** Bulgarian, Croatian, Czech, Danish, Dutch, **English**, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, **Russian**, Slovak, Slovenian, Spanish, Swedish, Ukrainian.

**Text-to-speech:** English (Kokoro-82M, ~70 voices), Russian (Piper `ru-denis`), plus any macOS system voice via `--voice macos-*`.

## Performance

- ASR: ~19× faster than OpenAI Whisper on Apple Silicon (CoreML via FluidAudio), ~2.5× on CPU (ONNX via `ort`).
- TTS: sub-second latency for short utterances on Apple Silicon.

## Why local

No API keys to manage. No per-minute billing. Voice data never leaves the machine — important for regulated industries, personal messaging, and anything that shouldn't be in a third-party log.

## Links

- Source: https://github.com/drakulavich/kesha-voice-kit
- npm: https://www.npmjs.com/package/@drakulavich/kesha-voice-kit
- Releases: https://github.com/drakulavich/kesha-voice-kit/releases
