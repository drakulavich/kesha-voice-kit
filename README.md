<p align="center">
  <img src="https://github.com/drakulavich/kesha-voice-kit/raw/main/docs/assets/logo.png" alt="Kesha Voice Kit" width="200">
</p>

<h1 align="center">Kesha Voice Kit</h1>

<p align="center">
  <a href="https://flakiness.io/Laputa/kesha-voice-kit"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fflakiness.io%2Fapi%2Fbadge%3Finput%3D%257B%2522badgeToken%2522%253A%2522badge-2IKMRRqUxh9P3w8Ym3Szf0%2522%257D" alt="Tests"></a>
  <a href="https://www.npmjs.com/package/@drakulavich/kesha-voice-kit"><img src="https://img.shields.io/npm/v/@drakulavich/kesha-voice-kit" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun"></a>
</p>

<p align="center"><b>Give your local tools and LLM agents a voice.</b><br>Fast speech-to-text, text-to-speech, voice-activity detection, and language detection in one local-first CLI: Apple Silicon CoreML first, ONNX fallback on supported Linux/Windows builds.</p>

- **Transcribe locally** — [25 languages](docs/languages.md), up to ~19x faster than Whisper on Apple Silicon, ~2.5x on CPU
- **Speak back** — text-to-speech in [9 languages](docs/languages.md)
- **Plug into agents** — ship voice workflows as CLI commands, an MCP server, an <a href="https://github.com/openclaw/openclaw">OpenClaw</a> skill, or a <a href="docs/hermes.md">Hermes</a> agent
- **Small Rust engine** — single ~20MB binary, no ffmpeg, no Python, no native Node addons

<p align="center">
  <img src="https://github.com/drakulavich/kesha-voice-kit/raw/main/demo.gif" alt="kesha demo — English + Russian transcription with automatic language detection" width="800">
</p>

## Quick Start

Runtime: **[Bun](https://bun.sh)** >= 1.3.0 · Platforms: macOS arm64, Linux x64, Windows x64.

```bash
# 1. Install Bun (skip if you have it) — Linux & macOS:
curl -fsSL https://bun.sh/install | bash        # or: brew install oven-sh/bun/bun
# Windows: powershell -c "irm bun.sh/install.ps1 | iex"

# 2. Install Kesha:
bun add -g @drakulavich/kesha-voice-kit
kesha install        # downloads engine + models (explicit — never automatic)

# 3. Transcribe:
kesha audio.ogg      # transcript to stdout
```

Prefer Homebrew, `.deb`/`.rpm`, Docker, or Nix? See [Other install methods](#other-install-methods).
Air-gapped or behind a corporate mirror? See [docs/model-mirror.md](docs/model-mirror.md).

## Speech-to-text

```bash
kesha audio.ogg                            # transcribe (plain text)
kesha --format transcript audio.ogg        # text + language/confidence
kesha --format json audio.ogg              # full JSON with lang fields
kesha --json --timestamps audio.ogg        # JSON with timestamped segments
kesha --toon audio.ogg                     # compact LLM-friendly TOON
kesha status                               # show installed backend info
```

Multiple files get `head`-style headers; stdout is the transcript, stderr is errors — pipe-friendly:

```bash
$ kesha freedom.ogg tahiti.ogg
=== freedom.ogg ===
Свободу попугаям! Свободу!

=== tahiti.ogg ===
Таити, Таити! Не были мы ни в какой Таити! Нас и тут неплохо кормят.
```

- **Long / silence-heavy audio:** install VAD (`kesha install --vad`); Kesha auto-uses it past 120 s. Without VAD, long audio falls back to fixed ASR chunks. See [docs/vad.md](docs/vad.md).
- **Speaker diarization** (darwin-arm64): `kesha install --diarize`, then `kesha --json --vad --speakers meeting.m4a` stamps each segment with a `speaker` id. Linux/Windows return a clear "darwin-arm64 only" error ([#199](https://github.com/drakulavich/kesha-voice-kit/issues/199)).

## Text-to-speech

Kesha speaks back in [9 languages](docs/languages.md), auto-picking the voice from the text's language. Override with `--lang <code>` or `--voice <id>`.

```bash
kesha install --tts                              # opt-in models (~990MB)
kesha say "Hello, world" > hello.wav
kesha say "Привет, мир" > privet.wav             # auto-routes by language
kesha say --voice ru-vosk-m02 "Голос в текст." > ru.wav
```

**Output formats** (`--format`, or inferred from the `--out` extension):

```bash
kesha say "Hello" --out hi.wav                    # WAV (default, uncompressed)
kesha say "Hello" --format ogg-opus --out hi.ogg  # OGG/Opus — messenger voice notes
kesha say "Hello" --format flac --out hi.flac     # FLAC — lossless, plays in every browser incl. Safari/iOS
```

`kesha say --list-voices` lists what's installed. Voices, the full catalogue, macOS system voices, SSML, speaking rate (`--rate`, `<prosody>`), Russian word stress, and Russian/English abbreviation handling are all in **[docs/tts.md](docs/tts.md)**.

## Languages

**Speech-to-text** spans 25 languages and **text-to-speech** covers English, Russian, and select multilingual voices — full tables with codes and flags in **[docs/languages.md](docs/languages.md)**. Audio language detection identifies [107 languages](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa).

## Performance

> **Up to ~19x faster than Whisper** on Apple Silicon (M2), **~2.5x faster** on CPU

Compared against Whisper `large-v3-turbo`, all engines auto-detecting language:

![Benchmark: openai-whisper vs faster-whisper vs Kesha Voice Kit](https://github.com/drakulavich/kesha-voice-kit/raw/main/docs/assets/benchmark.svg)

Full per-file breakdown (Russian + English): [BENCHMARK.md](BENCHMARK.md).

## Other install methods

All of these install the Bun CLI wrapper; engine + models still download explicitly via `kesha install`.

- **Homebrew** — `brew install drakulavich/tap/kesha-voice-kit` · [docs/homebrew.md](docs/homebrew.md)
- **Linux packages** (`.deb`/`.rpm`, x64) — [docs/linux-packages.md](docs/linux-packages.md)
- **Docker** (GHCR image) — [docs/docker.md](docs/docker.md)
- **Nix** (`aarch64-darwin` / `x86_64-linux`) — `nix run github:drakulavich/kesha-voice-kit -- install` · [docs/nix-install.md](docs/nix-install.md)
- **Shell completions + manpage** — `kesha completions bash|zsh|fish` and `kesha manpage` print the packaged files to install wherever your shell expects them.

## Integrations

- **MCP server** — `kesha mcp` exposes transcribe/synthesize/list tools to any MCP client (Claude, Cursor, Codex, Gemini). Setup: [docs/mcp.md](docs/mcp.md).
- **OpenClaw** — give your LLM agent ears. Install & config: [docs/openclaw.md](docs/openclaw.md).
- **Hermes Agent** — local STT/TTS through Hermes command providers. Setup: [docs/hermes.md](docs/hermes.md).
- **Raycast** (macOS) — transcribe selected audio & speak the clipboard from the launcher. Source + install: [`raycast/`](raycast/).
- **Programmatic API** — `@drakulavich/kesha-voice-kit/core` for use inside a Bun program. See [docs/api.md](docs/api.md).

## More

- [Architecture](docs/architecture.md) — runtime data flow, the models that ship, the CLI ↔ Rust engine boundary, model pinning, and where tests live.
- [Use cases](docs/use-cases.md) — copy-paste recipes (transcribe a meeting, speak from OpenClaw, run offline, move the cache).
- [Product positioning](docs/product-positioning.md) — supported workflows, non-goals, maturity labels, platform matrix.
- **Diagnostics:** `kesha doctor`, `kesha support-bundle` (redacted `.tar.gz` for issues), and `kesha logs` produce local, content-free diagnostics — see [docs/diagnostic-logs.md](docs/diagnostic-logs.md). Every failure prints a stable `error [CODE]: …` line ([docs/errors.md](docs/errors.md)).
- **Privacy / Local Stats:** Stats are **off by default** and fully local. Opt in with `kesha stats enable` to record content-free operational metrics in a local SQLite database — never networked, never storing audio, transcripts, text, or paths. Full commands & lifecycle: [docs/local-stats.md](docs/local-stats.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [Roadmap](ROADMAP.md) (Now / Next / Later), and the [Decision log](docs/decision-log.md) (why platform/model choices were made — and reversed). Dev setup: `make dev-setup` (Bun, Rust, nextest, platform libs).

## License

Made with 💛🩵 and 🥤 energy under MIT License
