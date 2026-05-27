# Decision log

Why Kesha Voice Kit is built the way it is. Each entry records a decision that
shaped the architecture, the models, or the toolchain — including the ones we
reversed, since the pivots are as informative as the choices that stuck.

Format per entry: **Decision**, **Context**, **Rationale**, **Status** (with the
issue/PR that drove it). Newest concerns first within each section.

---

## Architecture

### Thin Bun/TS CLI over a standalone Rust engine
- **Decision:** `kesha` is a Bun/TypeScript CLI that shells out to a single Rust
  binary (`kesha-engine`) as a subprocess, rather than linking native code in-process.
- **Rationale:** keeps the CLI install fast and dependency-light (no native build at
  `npm`/`bun add` time); the heavy ML work lives in a self-contained binary downloaded
  from GitHub Releases. The two are versioned independently (`package.json#version` vs
  `package.json#keshaEngine.version`) so CLI-only patches ship without rebuilding the engine.
- **Status:** active.

### Engine and models are never auto-downloaded
- **Decision:** `kesha install` downloads the engine/models explicitly; nothing is
  fetched on first transcription/synthesis. Missing assets produce an actionable error.
- **Rationale:** avoid surprising multi-GB downloads triggered by an innocent-looking
  command. Predictability over convenience.
- **Status:** active (hard rule).

### Bun-only CLI runtime, no build step
- **Decision:** the CLI uses Bun-native APIs (`Bun.spawn`, `Bun.file`, …) and runs
  TypeScript directly — no transpile/bundle step.
- **Rationale:** simplest possible dev loop and distribution; the engine binary is the
  only compiled artifact.
- **Status:** active.

## Speech-to-text (ASR)

### Dual compile-time backend: CoreML (Apple Silicon) / ONNX (everywhere else)
- **Decision:** exactly one ASR backend is compiled per binary — CoreML via
  `fluidaudio-rs` (Apple Neural Engine) on `darwin-arm64`, ONNX via `ort` on
  Linux/Windows/fallback. No runtime fallback between them.
- **Rationale:** the ANE path is dramatically faster on Macs; ONNX is the portable
  baseline. Selecting at compile time keeps each binary lean and avoids shipping two
  inference stacks in one artifact.
- **Status:** active.

### ASR model: NVIDIA Parakeet TDT 0.6B v3
- **Decision:** use Parakeet TDT 0.6B (the `istupakov/parakeet-tdt-0.6b-v3-onnx`
  export for the ONNX path) as the transcription model.
- **Rationale:** ~19× faster than Whisper on Apple Silicon at competitive accuracy,
  multilingual, and available as a clean ONNX export. Language detection (SpeechBrain
  ECAPA-TDNN) always runs through ONNX regardless of the ASR backend.
- **Status:** active.

## Text-to-speech (TTS)

### Three engines selected by voice-id prefix
- **Decision:** `en-*` → Kokoro-82M (24 kHz), `ru-*` → Vosk-TTS (22.05 kHz),
  `macos-*` → an AVSpeech Swift sidecar (zero model download).
- **Rationale:** best-in-class small models per language plus a zero-install OS option
  on macOS. Prefix routing keeps the selection explicit and testable.
- **Status:** active ([#141] AVSpeech sidecar, [#213] Vosk-TTS).

### Default voices must be male
- **Decision:** every language's default voice is male (`en-am_michael`,
  `ru-vosk-m02`, `Milena`→male auto-routing on darwin). Female voices remain
  selectable via explicit `--voice`.
- **Rationale:** Kesha (Кеша) is a male name — this is the brand voice. New defaults
  are chosen by ear from the `m_*` set, not alphabetically.
- **Status:** active (hard rule).

### G2P: CharsiuG2P → espeak-ng → embedded misaki-rs / Vosk internals
- **Decision:** grapheme-to-phoneme now uses embedded `misaki-rs` for English ([#207])
  and Vosk-TTS internals (BERT prosody + dictionary) for Russian ([#213]). No system deps.
- **Context / pivots:** CharsiuG2P ([#123]) and espeak-ng ([#210]) were both tried and
  removed in [#213]. espeak-ng turned out to be dynamic-link-only in `espeakng-sys`,
  which conflicted with the static-binary distribution model ([#124]).
- **Rationale:** ship a self-contained binary with no runtime system dependencies; the
  embedded lexicon path is reproducible and matches the Kokoro-trained inventory.
- **Status:** active; CharsiuG2P + espeak-ng retired.

### TTS engine pivot: Silero → Piper → (removed)
- **Decision:** the original spec assumed Silero TTS; it was dropped during the M3
  spike because Silero ships PyTorch-only with no public ONNX export. Piper was adopted
  as the interim path and later removed in favor of the current Kokoro/Vosk/AVSpeech split.
- **Rationale / lesson:** verify third-party model formats with a throwaway end-to-end
  spike *before* committing a plan to them. See
  `docs/superpowers/specs/2026-04-16-bidirectional-voice-design.md`.
- **Status:** superseded by the three-engine split.

### Web-playable output: FLAC over MP3/AAC; OGG/Opus for messengers
- **Decision:** `kesha say --format flac` (pure-Rust `flacenc`) is the lossless,
  browser-universal output added in v1.20; `--format ogg-opus` stays the
  messenger-friendly compressed default ([#223]); WAV remains the raw default.
- **Context:** the website "Hear it" samples needed Safari/iOS playback, which
  OGG/Opus lacks. MP3 was evaluated and rejected (all viable encoders are LGPL
  copyleft); AAC was rejected (active patent-pool exposure + macOS-only sidecar).
- **Rationale:** FLAC is patent-free, plays natively in every modern browser including
  Safari/iOS, and has a permissive pure-Rust encoder — no C dep, no license drama.
- **Status:** active (v1.20).

## Interfaces

### Local MCP server (`kesha mcp`), stdio-only
- **Decision:** a Bun/TS `kesha mcp` subcommand runs a Model Context Protocol server
  over stdio, exposing `transcribe_audio`, `synthesize_speech`, `list_voices`,
  `list_languages` by orchestrating the existing public API. No remote transport in v1.
- **Rationale:** let any MCP client (Claude Desktop/Code, Cursor, OpenClaw) drive
  Kesha locally without re-implementing engine logic or adding a new engine surface
  (kept as a CLI-only change). Synthesized audio is returned as a `kesha-audio://`
  MCP resource, not inline base64, to keep JSON-RPC payloads small.
- **Status:** active ([#473]).

### TOON output for LLM pipelines
- **Decision:** `--toon` emits compact tabular output for piping multi-file results
  into an LLM, alongside `--json`.
- **Rationale:** ~30–60% fewer tokens than JSON while round-tripping to the same
  structured results.
- **Status:** active ([#138]).

## Packaging & supply chain

### Pinned model SHA-256 hashes
- **Decision:** every model file in `rust/src/models.rs` carries a pinned SHA-256;
  `download_verified` refuses any file whose hash doesn't match.
- **Rationale:** makes `KESHA_MODEL_MIRROR` safe (a compromised mirror can't swap
  weights) and turns an upstream HuggingFace republish into a deliberate, reviewed
  change rather than a silent swap. Never disable verification to "get it working" ([#174]).
- **Status:** active (hard rule).

### Signed, attested releases (Sigstore + SBOM + npm provenance)
- **Decision:** engine release assets ship `SHA256SUMS`, per-asset Sigstore bundles,
  and an SPDX SBOM; npm publishes with provenance attestation via GitHub Actions OIDC
  ([#291]); `cargo-deny` gates licenses/advisories.
- **Rationale:** verifiable supply chain end to end — users (and Homebrew) can confirm
  artifacts were built from this repo at the tagged commit.
- **Status:** active.

### Nix flake as an alternate reproducible build
- **Decision:** a Nix flake builds the engine + wraps the Bun CLI (`aarch64-darwin`,
  `x86_64-linux`); it is not a CI gate.
- **Rationale:** offer a hermetic build path without making it the canonical one — npm
  publish + the `make` flow remain authoritative.
- **Status:** active, secondary ([#242], [#264]).

---

[#123]: https://github.com/drakulavich/kesha-voice-kit/issues/123
[#124]: https://github.com/drakulavich/kesha-voice-kit/issues/124
[#138]: https://github.com/drakulavich/kesha-voice-kit/issues/138
[#141]: https://github.com/drakulavich/kesha-voice-kit/issues/141
[#174]: https://github.com/drakulavich/kesha-voice-kit/issues/174
[#207]: https://github.com/drakulavich/kesha-voice-kit/issues/207
[#210]: https://github.com/drakulavich/kesha-voice-kit/issues/210
[#213]: https://github.com/drakulavich/kesha-voice-kit/issues/213
[#223]: https://github.com/drakulavich/kesha-voice-kit/issues/223
[#242]: https://github.com/drakulavich/kesha-voice-kit/issues/242
[#264]: https://github.com/drakulavich/kesha-voice-kit/issues/264
[#291]: https://github.com/drakulavich/kesha-voice-kit/issues/291
[#473]: https://github.com/drakulavich/kesha-voice-kit/issues/473
