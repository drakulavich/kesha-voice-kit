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

<p align="center"><b>Give your local tools and LLM agents a voice.</b><br>Fast speech-to-text, text-to-speech, voice-activity detection, and language detection in one local-first CLI — CoreML on Apple Silicon, ONNX on Linux and Windows.</p>

- **Transcribe locally** — [25 languages](docs/languages.md#speech-to-text-25), up to ~19x faster than Whisper on Apple Silicon, ~2.5x on CPU
- **Speak back** — text-to-speech in [9 languages](docs/languages.md#text-to-speech)
- **Plug into agents** — ship voice workflows as CLI commands, an MCP server, an <a href="docs/openclaw.md">OpenClaw</a> skill, or a <a href="docs/hermes.md">Hermes</a> agent
- **Small Rust engine** — single ~65MB binary, no ffmpeg, no Python, no native Node addons

<p align="center">
  <img src="https://github.com/drakulavich/kesha-voice-kit/raw/main/demo.gif" alt="kesha demo — English + Russian transcription with automatic language detection" width="800">
</p>

## Quick Start

Runtime: **[Bun](https://bun.sh)** >= 1.3.0.

```bash
# 1. Install Bun (skip if you have it)
curl -fsSL https://bun.sh/install | bash        # macOS/Linux — or: brew install oven-sh/bun/bun
powershell -c "irm bun.sh/install.ps1 | iex"    # Windows

# 2. Install Kesha
bun add -g @drakulavich/kesha-voice-kit
kesha --version                                 # confirms `kesha` resolved on PATH

# 3. Download the engine and models — pick one path
kesha init                                      # guided: backend, languages, TTS voices
kesha install --plan && kesha install           # manual: preview the sizes, then download

# 4. Transcribe
kesha audio.ogg                                 # transcript to stdout
```

`kesha install` pulls ~2.5 GB on Linux/Windows and ~0.6 GB on Apple Silicon, whose CoreML engine reads a smaller model set. It is always explicit — nothing downloads behind your back — and the model step has no progress bar, so expect a few quiet minutes. If `bun --version` fails right after step 1, reload your PATH: `exec $SHELL -l`.

Prefer Homebrew, Docker, or Nix? See [Other install methods](#other-install-methods).
Air-gapped or behind a corporate mirror? See [docs/model-mirror.md](docs/model-mirror.md).

### Platform support

All three targets transcribe, detect the spoken language, run VAD, and speak. The macOS-only rows need Apple frameworks — they are not a missing port. Windows is a tested path rather than a published binary nobody ran: CI does a cold `kesha install` on `windows-latest`, transcribes a fixture, and round-trips a synthesis ([#216](https://github.com/drakulavich/kesha-voice-kit/issues/216), [#667](https://github.com/drakulavich/kesha-voice-kit/pull/667)).

| | macOS arm64 | Linux x64 | Windows x64 |
|---|:---:|:---:|:---:|
| Transcribe · audio language ID · [VAD](docs/vad.md) | CoreML / ANE | ONNX CPU | ONNX CPU |
| TTS — `en` `ru` `es` `fr` `it` `pt` | ✅ | ✅ | ✅ |
| TTS — `hi` `ja` `zh` and macOS system voices | ✅ | — | — |
| Mic capture and live dictation (`kesha record`) | ✅ | — | — |
| Speaker diarization (`--speakers`) | ✅ | — | — |
| Word-level timestamps (`words` in `--json`) | ✅ | ✅ | ✅ |
| Voice auto-routing from the text's language | ✅ | pass `--lang` | pass `--lang` |

Intel Macs get no published engine binary. Full matrix with maturity labels: [docs/product-positioning.md](docs/product-positioning.md#platform-matrix).

## Speech-to-text

```bash
kesha audio.ogg                            # transcribe (plain text)
kesha --format transcript audio.ogg        # text + language/confidence
kesha --format json audio.ogg              # full JSON with lang fields
kesha --json --timestamps audio.ogg        # JSON with timestamped segments
kesha --itn audio.ogg                      # spelled-out numbers -> digits
kesha --toon audio.ogg                     # compact LLM-friendly TOON
kesha status                               # show installed backend info
kesha status --disk                        # + recursive cache disk usage
kesha status --json                        # machine-readable, for scripts
```

Multiple files get `head`-style headers; stdout is the transcript, stderr is errors — pipe-friendly:

```bash
$ kesha freedom.ogg tahiti.ogg
=== freedom.ogg ===
Свободу попугаям! Свободу!

=== tahiti.ogg ===
Таити, Таити! Не были мы ни в какой Таити! Нас и тут неплохо кормят.
```

- **Record from the mic (macOS):** `kesha record --out hello.wav` writes microphone audio to a WAV file (`kesha hello.wav` transcribes it). macOS prompts for microphone access on first use — grant it under System Settings → Privacy & Security → Microphone if it was denied. On Linux/Windows or headless boxes, pass any existing audio file straight to `kesha` instead.
- **Dictate straight to text (darwin-arm64):** `kesha record --live` transcribes the mic as it captures and prints the transcript to stdout — no WAV in between, so it pipes (`kesha record --live | pbcopy`). Progress goes to stderr. Other platforms keep the two-step `record --out` + transcribe flow. An interruption is recoverable: Ctrl-C (or SIGTERM) stops the session, still prints what you dictated, and exits 130/143, and the audio is spilled to a recovery WAV under `~/.cache/kesha/recordings/` — named on stderr when the session starts, deleted once the transcript has actually been delivered, kept if anything — a signal, a crash, a closed terminal, a dead pipe — got in the way first ([#962](https://github.com/drakulavich/kesha-voice-kit/issues/962)).
- **Long / silence-heavy audio:** install VAD (`kesha install --vad`); Kesha auto-uses it past 120 s. Without VAD, long audio falls back to fixed ASR chunks. See [docs/vad.md](docs/vad.md).
- **Speaker diarization** (darwin-arm64): `kesha install --diarize` (which installs VAD too), then `kesha --json --speakers meeting.m4a` stamps each segment with a `speaker` id. `--speakers` engages VAD windowing itself at any duration, so it cannot be combined with `--no-vad`. Linux/Windows return a clear "darwin-arm64 only" error ([#199](https://github.com/drakulavich/kesha-voice-kit/issues/199)).
- **Word-level timestamps** (every platform): `kesha --json --timestamps audio.ogg` adds a `words` array to each segment — `{ "word": "email", "start": 0.72, "end": 1.12 }` — on the same file-relative clock as the segment, so a word always lies inside the segment carrying it. Read them off the decoder's own frame grid, so: times are quantised to 0.08 s, consecutive spans may overlap (each `end` is a per-word duration prediction, not the next word's `start`), `end >= start` rather than strictly greater, and punctuation stays attached to its word. The key is simply absent where a segment has none — any segment `--itn` rewrote, for one — so check the `transcribe.words` capability rather than expecting an empty array ([#720](https://github.com/drakulavich/kesha-voice-kit/issues/720)).
- **Written-form numbers:** `--itn` rewrites what the model spells out — `"two hundred thirty two"` → `"232"`, `"five dollars and fifty cents"` → `"$5.50"`. Opt-in, every platform, timestamps untouched. English-only in practice; Russian and the rest pass through unchanged. Spoken punctuation names stay words (`"dot"`, `"comma"`, `"the period of growth"`) because Kesha transcribes speech rather than dictation — so `"example dot com"` keeps its words too ([#822](https://github.com/drakulavich/kesha-voice-kit/issues/822)).

## Text-to-speech

Kesha speaks back in [9 languages](docs/languages.md#text-to-speech). On macOS it picks the voice from the text's own language; on Linux and Windows text detection needs Apple frameworks, so state the language with `--lang <code>` (or the voice with `--voice <id>`) — otherwise the engine default speaks.

```bash
kesha install --tts                              # English voices; sizes differ per platform — preview: kesha install --plan
kesha install --tts en ru                        # + Russian (+~890 MB, Vosk)
kesha say "Hello, world" > hello.wav
kesha say "Привет, мир" > privet.wav             # auto-routes by language (macOS)
kesha say --lang ru "Привет, мир" > privet.wav   # explicit — the Linux/Windows path
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

**Speech-to-text** spans 25 languages and **text-to-speech** 9 — full tables with codes, flags, and per-platform availability in **[docs/languages.md](docs/languages.md)**. Audio language detection identifies [107 languages](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa).

## Performance

> **Up to ~19x faster than Whisper** on Apple Silicon (M2), **~2.5x faster** on CPU

Compared against Whisper `large-v3-turbo`, all engines auto-detecting language:

![Benchmark: openai-whisper vs faster-whisper vs Kesha Voice Kit](https://github.com/drakulavich/kesha-voice-kit/raw/main/docs/assets/benchmark.svg)

Full per-file breakdown (Russian + English): [BENCHMARK.md](BENCHMARK.md). The CPU figure is the ONNX engine on an M2's CPU cores; no x86 numbers are published yet.

## Other install methods

All of these install the Bun CLI wrapper; engine + models still download explicitly via `kesha install`.

- **Homebrew** — `brew install drakulavich/tap/kesha-voice-kit` · [docs/homebrew.md](docs/homebrew.md)
- **Linux packages** (`.deb`/`.rpm`, x64) — published on CLI releases, see [docs/linux-packages.md](docs/linux-packages.md)
- **Docker** (GHCR image) — [docs/docker.md](docs/docker.md)
- **Nix** (`aarch64-darwin` / `x86_64-linux`) — `nix run github:drakulavich/kesha-voice-kit -- install` · [docs/nix-install.md](docs/nix-install.md)
- **Shell completions + manpage** — `kesha completions bash|zsh|fish` and `kesha manpage` print the packaged files to install wherever your shell expects them.

## Integrations

- **MCP server** — `kesha mcp` exposes transcribe/synthesize/list tools to any MCP client (Claude, Cursor, Codex, Gemini). Setup: [docs/mcp.md](docs/mcp.md).
- **OpenClaw** — give your LLM agent ears. Install & config: [docs/openclaw.md](docs/openclaw.md).
- **Hermes Agent** — local STT/TTS through Hermes command providers. Setup: [docs/hermes.md](docs/hermes.md).
- **Raycast** (macOS) — offline microphone dictation from the launcher: *Dictate to Clipboard* records with a live signal meter, auto-stops on silence, transcribes locally, and copies the text. [Install from the Raycast Store](https://www.raycast.com/drakulavich/kesha-voice-kit) · source: [`raycast/`](raycast/).
- **Programmatic API** — `@drakulavich/kesha-voice-kit/core` for use inside a Bun program. See [docs/api.md](docs/api.md).

## More

- [Architecture](docs/architecture.md) — runtime data flow, the models that ship, the CLI ↔ Rust engine boundary, model pinning, and where tests live.
- [Use cases](docs/use-cases.md) — copy-paste recipes (transcribe a meeting, speak from OpenClaw, run offline, move the cache).
- [Product positioning](docs/product-positioning.md) — supported workflows, non-goals, maturity labels, platform matrix.
- [Changelog](CHANGELOG.md) — every release, with the behaviour changes spelled out.
- **Diagnostics:** `kesha doctor`, `kesha support-bundle` (redacted `.tar.gz` for issues), and `kesha logs` produce local, content-free diagnostics — see [docs/diagnostic-logs.md](docs/diagnostic-logs.md). Every failure prints a stable `error [CODE]: …` line and a documented [process exit code](docs/errors.md#process-exit-codes).
- **Scripting & CI:** `--json` (or `--toon`) for machine-readable output, `--include-errors` (with either) to get per-file failures on stdout alongside the results, `--quiet`/`-q` to silence progress, and `--no-color` (or `NO_COLOR=1`) for plain logs. Colors switch off automatically when `CI=true`.
- **Privacy / Local Stats:** Stats are **off by default** and fully local. Opt in with `kesha stats enable` to record content-free operational metrics in a local SQLite database — never networked, never storing audio, transcripts, text, or paths. Full commands & lifecycle: [docs/local-stats.md](docs/local-stats.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [Roadmap](ROADMAP.md) (Now / Next / Later), and the [Decision log](docs/decision-log.md) (why platform/model choices were made — and reversed). Dev setup: `just dev-setup` (Bun, Rust, nextest, platform libs).

## License

Made with 💛🩵 and 🥤 energy under MIT License
