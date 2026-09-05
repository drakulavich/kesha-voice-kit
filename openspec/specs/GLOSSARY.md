# Glossary

Canonical terms for the Kesha Voice Kit spec corpus. Specs use these terms
verbatim; if you need a new term, add it here first.

| Term | Definition |
|---|---|
| **CLI** | The `kesha` command — a Bun/TypeScript program installed from npm as `@drakulavich/kesha-voice-kit`. |
| **Engine** | The `kesha-engine` Rust binary, downloaded from GitHub Releases by `kesha install` and invoked by the CLI as a subprocess. Never linked in-process. |
| **Backend** | The compile-time ASR implementation inside the Engine: **CoreML** (Apple Silicon, FluidAudio/ANE) or **ONNX** (Linux/Windows/fallback, `ort`). Exactly one per Engine binary; no runtime fallback. |
| **Profile** | The cargo feature bundle an Engine binary was built from: **portable** (`onnx`, `tts`; builds anywhere) or **darwin** (CoreML plus the macOS system features). Every released binary is built from exactly one, and the describe document reports which as `profile`. |
| **Model cache** | `~/.cache/kesha/` (override: `KESHA_CACHE_DIR`) where the Engine binary and all models live. |
| **Pinned hash** | The SHA-256 recorded for every model file in `rust/src/models/manifest.rs`; downloads that don't match are rejected, never cached. |
| **Channel** | How a published artifact is selected: **stable**, what an install resolves when nothing is named, **alpha**, reached only by naming it (`@alpha` on npm), and **beta**, the release-candidate Prerelease Channel. npm dist-tags are the mechanism (v2: one version names both artifacts, and a per-merge alpha builds no Engine). |
| **Alpha** | An unblessed build published on the alpha channel so a change can be run before it is released. Version `<next-version>-alpha.N`, derived from existing tags at publish time and never committed. No stability promise. |
| **Prerelease** | A GitHub Release marked as not "Latest". Engine alphas are published Prereleases; beta Engine releases stay drafts until validated by hand. (v2: betas and dispatched alphas publish as Prereleases in the run that smoked their assets, so nothing is drafted.) |
| **Pinned Engine version** | `package.json#keshaEngine.version` — the Engine release the CLI downloads when nothing overrides it. The only version any unattended path resolves; nothing resolves a floating "latest". (v2: derived at publish time, never committed.) |
| **Recorded Engine version** | The version written beside the installed Engine binary as `<bin>.version`; what is actually on disk, which a mismatch with the Pinned Engine version causes `kesha install` to replace. |
| **Capabilities JSON** | The machine-readable self-description printed by `kesha-engine --capabilities-json` (protocol version 3); the CLI validates flags against it instead of blindly forwarding them. (v2: replaced by the `describe` document.) |
| **describe document** | The JSON self-description printed by `kesha-engine describe` (protocol version 4): `protocolVersion`, `backend`, `profile`, every subcommand with its flags and gates, `features`, the Error code taxonomy with origins, and TTS languages. The one place the CLI learns what the Engine accepts. |
| **Error code** | A stable `E_*` identifier (e.g. `E_MODEL_MISSING`) printed by the Engine on stderr as `error [E_CODE]: message`; the full taxonomy comes from `--error-codes-json`. (v2: also `exitCode`/`stderr` on `KeshaError`.) |
| **Event stream** | The NDJSON lines the Engine writes to stderr, one JSON object per line with a `kind` of `progress`, `warn`, `error` or `debug`; stdout carries payload only, and the CLI is what renders events for a person. |
| **Exit code** | Process status: 0 success, 1 runtime failure, 2 invalid arguments; `kesha say` additionally uses 4 (synthesis/internal) and 5 (text too long). An interrupted run exits 130 (SIGINT) or 143 (SIGTERM). |
| **KeshaError** | The single class every Core API rejection carries: `code` (a published Error code), `hint` when a remedy is known, and `exitCode`/`stderr` whenever an Engine subprocess ran or a pre-flight assigned an Exit code. Replaces `SayError`. |
| **CLI package** | The npm tarball `@drakulavich/kesha-voice-kit`: the `kesha` entry point plus its TypeScript sources, run by Bun with no build step. Every distribution path unwraps this same package. |
| **Distribution path** | A supported way to get the CLI onto a machine: the npm CLI package, the Homebrew formula, the `.deb`/`.rpm` Linux packages, the GHCR container image, or the Nix flake. None of them installs the Engine. |
| **MCP registry manifest** | `server.json` — the manifest that advertises the CLI package to MCP clients; its version is held equal to the CLI's by the drift gate. |
| **OpenClaw plugin** | The plugin shipped inside the CLI package (`openclaw.plugin.json` + `openclaw-plugin.cjs`) that declares a discoverable audio provider so an OpenClaw agent can transcribe voice messages; the transcript is produced by OpenClaw's configured `type: "cli"` path running the `kesha` CLI, not by the plugin. |
| **Audio ingest** | Opening an audio file and turning it into what a model consumes: decode (symphonia + rubato, never `ffmpeg`), mix to mono, resample to 16 kHz. |
| **Process tree** | An Engine subprocess together with any Sidecar it spawned; interruption terminates the tree, not just the direct child. |
| **Star prompt** | The one-time post-install invitation to star the repository, shown on a first install or a major/minor bump and gated by a marker file beside the Engine binary. |
| **Transcription** | Speech-to-text of an audio file via the Backend (Parakeet TDT 0.6B v3). The CLI's default command. |
| **Segment** | A time-bounded slice of a Transcription: `{start, end, text}` seconds, optionally with a Speaker label. |
| **Diarization** | Assigning Speaker labels (cluster indices) to Segments; requires darwin-arm64 and the Sortformer model installed via `kesha install --diarize`. |
| **Speaker** | An unsigned integer cluster index, stable within one Transcription only. |
| **VAD** | Voice-activity detection (Silero v5) used to split long audio before Transcription. Modes: **auto** (default), **on** (`--vad`), **off** (`--no-vad`). |
| **Language detection (audio)** | Identifying the spoken language of audio (ECAPA-TDNN VoxLingua107, first 10 s), returning `{code, confidence}`. |
| **Language detection (text)** | Identifying the language of a string (macOS `NLLanguageRecognizer`; `tinyld` fallback in the CLI). |
| **TTS** | Text-to-speech via `kesha say` or the `say()` API. |
| **TTS engine** | One of **Kokoro** (Kokoro-82M, 24 kHz), **Vosk** (Vosk-TTS Russian, multi-speaker), or **AVSpeech** (macOS system voices via Swift sidecar). Selected by Voice id prefix. |
| **Voice id** | `<lang>-<name>` identifier such as `en-am_michael`, `ru-vosk-m02`, `macos-com.apple.voice.compact.ru-RU.Milena`. The prefix routes to a TTS engine. |
| **Default voice** | The voice chosen when none is given. Must be male (brand rule); documented exception: `fr-ff_siwis`. |
| **Voice routing** | Choosing a Voice id from `--voice`, `--lang`, or detected text language (`pickVoiceForLang`), in that precedence order. |
| **SSML** | Speech Synthesis Markup Language subset accepted by `kesha say --ssml` (`<speak>`, `<break>`, `<say-as>`, `<phoneme>`, `<emphasis>`, `<prosody>`). |
| **Normalization** | Pre-synthesis text rewriting: acronym letter-spelling, number-to-words expansion, IPA lexicon overrides; per-language stop-lists exempt word-like acronyms. |
| **Sidecar** | A helper binary shipped next to the Engine (`say-avspeech`, `kesha-textlang`), resolved sibling-of-exe first. |
| **Output format (transcribe)** | One of **text** (default), **verbose**, **transcript**, **json**, **toon** — selected by `--format`/`--json`/`--toon`. |
| **TOON** | Token-oriented object notation (`@toon-format/toon`): compact tabular encoding of the same data as `--json`, losslessly decodable. |
| **Output format (TTS)** | One of **wav** (default, IEEE-float mono), **ogg-opus**, **flac**. |
| **Install plan** | The dry-run preview (`--plan`) listing components, sizes, and cache status before any download. |
| **Never-auto-download rule** | The Engine and models download only during explicit `kesha install` / `kesha init`; every other command fails with an actionable hint when something is missing. Where a third-party runtime would fetch on its own — FluidAudio Kokoro on darwin-arm64 — the rule is upheld by checking the assets are on disk before that runtime is handed anything. |
| **Diagnostic log** | Privacy-safe local NDJSON event log managed by `kesha logs` (modes: off / on / retain-on-failure). No transcript content or file paths. |
| **Stats DB** | Local SQLite database of anonymous performance metrics managed by `kesha stats`. |
| **Support bundle** | Redacted `.tar.gz` diagnostics archive produced by `kesha support-bundle`. |
| **Redaction** | Removing secrets (TOKEN/KEY/SECRET/… values), home-directory paths, and URL credentials from diagnostic output. |
| **MCP server** | The Model Context Protocol stdio server started by `kesha mcp`, exposing transcribe/synthesize/list tools to LLM clients. |
| **Core API** | The programmatic interface exported from `@drakulavich/kesha-voice-kit/core`: today `transcribe`, `say`, `downloadModel`, `downloadTts`, `toToon`, `SayError`; v2 replaces those with `transcribe`, `say`, `install`, `capabilities`, `toToon` and `KeshaError`. |
| **Model mirror** | `KESHA_MODEL_MIRROR` base URL that rewrites HuggingFace download URLs (GitHub release URLs are never rewritten); safe because of Pinned hashes. |
| **Raycast extension** | The `kesha-voice-kit` extension published to the Raycast Store; its source of record is `raycast/` in this repo. It drives the CLI as a subprocess and never links the Engine or reimplements Transcription. |
| **Dictation session** | One run of the Raycast extension's **Dictate to Clipboard** command: record → silence check → Transcription → clipboard. |
| **Signal meter** | The live microphone level readout shown while a Dictation session records — `{rms, peak, percent}` samples classified as **signal** or **listening**. |
| **Idle auto-stop** | Ending a Dictation session's recording automatically after a continuous **listening** stretch: warn at 30 s, stop 15 s later. |
