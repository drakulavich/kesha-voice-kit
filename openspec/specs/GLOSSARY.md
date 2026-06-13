# Glossary

Canonical terms for the Kesha Voice Kit spec corpus. Specs use these terms
verbatim; if you need a new term, add it here first.

| Term | Definition |
|---|---|
| **CLI** | The `kesha` command — a Bun/TypeScript program installed from npm as `@drakulavich/kesha-voice-kit`. |
| **Engine** | The `kesha-engine` Rust binary, downloaded from GitHub Releases by `kesha install` and invoked by the CLI as a subprocess. Never linked in-process. |
| **Backend** | The compile-time ASR implementation inside the Engine: **CoreML** (Apple Silicon, FluidAudio/ANE) or **ONNX** (Linux/Windows/fallback, `ort`). Exactly one per Engine binary; no runtime fallback. |
| **Model cache** | `~/.cache/kesha/` (override: `KESHA_CACHE_DIR`) where the Engine binary and all models live. |
| **Pinned hash** | The SHA-256 recorded for every model file in `rust/src/models.rs`; downloads that don't match are rejected, never cached. |
| **Capabilities JSON** | The machine-readable self-description printed by `kesha-engine --capabilities-json` (protocol version 3); the CLI validates flags against it instead of blindly forwarding them. |
| **Error code** | A stable `E_*` identifier (e.g. `E_MODEL_MISSING`) printed by the Engine on stderr as `error [E_CODE]: message`; the full taxonomy comes from `--error-codes-json`. |
| **Exit code** | Process status: 0 success, 1 runtime failure, 2 invalid arguments; `kesha say` additionally uses 4 (synthesis/internal) and 5 (text too long). |
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
| **Never-auto-download rule** | The Engine and models download only during explicit `kesha install` / `kesha init`; every other command fails with an actionable hint when something is missing. |
| **Diagnostic log** | Privacy-safe local NDJSON event log managed by `kesha logs` (modes: off / on / retain-on-failure). No transcript content or file paths. |
| **Stats DB** | Local SQLite database of anonymous performance metrics managed by `kesha stats`. |
| **Support bundle** | Redacted `.tar.gz` diagnostics archive produced by `kesha support-bundle`. |
| **Redaction** | Removing secrets (TOKEN/KEY/SECRET/… values), home-directory paths, and URL credentials from diagnostic output. |
| **MCP server** | The Model Context Protocol stdio server started by `kesha mcp`, exposing transcribe/synthesize/list tools to LLM clients. |
| **Core API** | The programmatic interface exported from `@drakulavich/kesha-voice-kit/core` (`transcribe`, `say`, `downloadModel`, …). |
| **Model mirror** | `KESHA_MODEL_MIRROR` base URL that rewrites HuggingFace download URLs (GitHub release URLs are never rewritten); safe because of Pinned hashes. |
