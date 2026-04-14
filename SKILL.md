# Kesha Voice Kit

Local speech-to-text for voice messages. Runs entirely on your machine — no API keys, no cloud.

## What it does

When a voice message arrives (Telegram, WhatsApp, Slack), Kesha transcribes it and returns JSON with the transcript and detected language:

```json
[{
  "file": "voice.ogg",
  "text": "Привет, как дела?",
  "lang": "ru",
  "textLanguage": { "code": "ru", "confidence": 0.99 }
}]
```

Use the `lang` field to detect which language the user spoke and respond accordingly.

## Setup

After installing the plugin, run once to download the engine and models:

```bash
kesha install
```

## Plain text mode

If you don't need language detection, switch to plain text output in your config:

```json
{
  "type": "cli",
  "command": "kesha",
  "args": ["{{MediaPath}}"]
}
```

This returns just the transcript text without JSON wrapping.

## Available flags

- `--json` — JSON output with language detection (default in this plugin)
- `--verbose` — show language detection details (audio + text language with confidence)
- `--lang <code>` — warn if detected language differs from expected (e.g. `--lang en`)

## Supported languages

Speech-to-text: Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian.

## Performance

~19x faster than Whisper on Apple Silicon (CoreML), ~2.5x faster on CPU (ONNX).
