# Changelog

All notable changes to `@drakulavich/kesha-voice-kit` are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

CLI and engine versions are **decoupled** — see `CLAUDE.md` for details. Tags
with a `-cli` suffix are CLI-only patches that reuse the previous engine
binary.

## [1.4.2] — 2026-04-23

### Added
- `kesha status` prints per-component disk usage (engine, ASR, lang-id, VAD,
  Kokoro, Piper, G2P) with a total + `rm -rf` cleanup hint. Missing components
  are skipped so partial installs stay tidy. (#197)

### Changed
- `package.json#description` aligned with the GitHub About blurb — now
  surfaces TTS (Kokoro + Piper + ~180 macOS system voices, SSML) and VAD
  alongside STT + language detection. (#198)

CLI-only release; engine v1.4.1 unchanged.

## [1.4.1] — 2026-04-23

### Added
- SSML `<phoneme alphabet="ipa" ph="…">` override — bypass G2P and feed IPA
  directly to Kokoro / Piper for rare words or proper nouns. (#193)
- G2P parity harness (`rust/tests/g2p_parity.rs`): 40 words × 11 languages
  locked against reference phonemes; catches tokenizer / tie-break drift that
  SHA-256 on the ONNX weights alone wouldn't notice. (#193)
- `BENCHMARK.md` G2P section — 149 ms/word measured end-to-end.

## [1.4.0] — 2026-04-23

### Added
- ONNX G2P (CharsiuG2P ByT5-tiny) shared by Kokoro and Piper. Byte-identical
  IPA vs. the Python reference on in-dictionary English. (#190)
- Smart VAD auto-engages on input ≥ 120 s when `kesha install --vad` is set;
  `--vad` / `--no-vad` override either direction. (#188)
- Manual `--vad` flag via Silero VAD v5 through `ort`. (#186)
- `NOTICES.md` bundled in the npm package (CC-BY 4.0 attribution for
  CharsiuG2P + catalog of bundled / downloaded artifacts). (#189)

### Removed
- `espeak-ng` runtime dependency — no more `brew install` / `apt install` /
  `choco install` step for TTS on any platform.

### Changed
- **Breaking**: `kesha install --tts` grew from ~390 MB to ~490 MB (FP32 G2P
  adds ~100 MB; INT8 quantization tracked as follow-up).
- Public Rust API: `kesha_engine` now exposes `pub mod models` and
  `pub mod util`.

## [1.3.0] — 2026-04-20

### Added
- macOS AVSpeechSynthesizer ships in release binaries. `kesha say --voice
  macos-*` works out of the box on darwin-arm64 with zero model download and
  ~180 system voices. `kesha install` fetches the Swift sidecar alongside the
  engine; falls back gracefully if the download 404s. (#141, #166)
- Windows TTS in release binaries (`--features coreml,tts` / `onnx,tts`
  matrix). Requires `choco install espeak-ng` at runtime. (#136, #159, #162)

### Changed
- Test-suite cleanup per Luca Rossi's contract-vs-implementation framework:
  −130 LOC of liability unit tests, +3 integration tests (net −67 LOC). (#163)

## [1.2.2] — 2026-04-20

### Changed
- `kesha install` GitHub-star prompt now fires only on first install or
  major/minor CLI bumps; patch re-installs and same-version runs stay silent.
  A `.star-seen` marker records the last prompted version. (#154)

CLI-only release; engine v1.2.0 unchanged.

## [1.2.1] — 2026-04-20

### Fixed
- `kesha install` detects a stale cached engine after a CLI upgrade and
  re-downloads automatically. Previously `--no-cache` was required across an
  engine-version bump. Closes #151. (#152)

CLI-only release; engine v1.2.0 unchanged.

## [1.2.0] — 2026-04-20

### Added
- SSML preview (`kesha say --ssml`): `<speak>` root + `<break time="…">`
  silence; unknown tags (`<emphasis>`, `<prosody>`, `<phoneme>`, `<say-as>`)
  strip with a stderr warning. `<!DOCTYPE>` rejected as XXE defense. (#140)
- Latency telemetry — `sttTimeMs` in `--json` output, `STT time: …ms` in
  `--verbose`, `TTS time: …ms` for `kesha say --verbose`. (#142, #143)
- macOS AVSpeechSynthesizer dev-build preview (`--features system_tts`);
  release binaries don't ship the sidecar yet. (#141, #144, #147)
- `--debug` flag / `KESHA_DEBUG=1` env traces engine subprocess calls to
  stderr without polluting the stdout pipe. (#149)

### Fixed
- `integration-tests` CI job installs `espeak-ng` on the macOS runner so the
  dynamic link against `libespeak-ng.1.dylib` resolves.

## [1.1.3] — 2026-04-18

First release with **bidirectional voice** — Kesha speaks back.

### Added
- `kesha say` TTS command with Kokoro-82M (English) + Piper VITS (Russian),
  auto-routed by `NLLanguageRecognizer` on input text. Opt-in via
  `kesha install --tts` (~390 MB). Output: WAV mono f32 (24 kHz Kokoro,
  22.05 kHz Piper) to stdout or `--out`. (#125, #126, #129)
- Programmatic API: `say`, `downloadTts` exported from
  `@drakulavich/kesha-voice-kit/core`.

### Fixed
- Build-engine feature matrix mirrors cargo defaults so released binaries
  include `tts`. (#133)
- `LIBCLANG_PATH` set from `llvm-config --libdir` on Linux CI runners so
  bindgen via `espeakng-sys` loads libclang correctly. (#133)

> **Release-notes note**: this release's GitHub notes body originally shipped
> empty because `gh release edit --notes` silently drops content on already
> published releases. Recovered via a direct API PATCH. See `CLAUDE.md` →
> "RELEASE PROCESS".

## [1.0.10] — 2026-04-16

### Changed
- README update for the npm package. No code changes since v1.0.9.

CLI-only release; engine v1.0.2 unchanged.

## [1.0.9] — 2026-04-16

### Added
- `--format` flag: `--format transcript` emits enriched plain text with a
  `[lang: …, confidence: …]` metadata line; `--format json` mirrors `--json`
  for symmetry. Recommended for OpenClaw `type: "cli"` audio providers.

CLI-only release; engine v1.0.2 unchanged.

## [1.0.8] — 2026-04-15

Rolls up OpenClaw-integration iterations v1.0.3–v1.0.8.

### Added
- OpenClaw `MediaUnderstandingProvider` that actually routes audio through
  the local `kesha` CLI (not the earlier stub + invented `configPatch`
  field). `autoPriority.audio: 50` selects Kesha over groq (20) when
  `tools.media.audio` is enabled.
- CLI-only marker releases via `-cli` tag suffix — excluded from
  `build-engine.yml`'s trigger filter so the Rust build is skipped.

### Changed
- Decoupled CLI and engine versioning. `src/engine-install.ts` reads
  `package.json#keshaEngine.version` (fallback: `package.json#version`) when
  deriving the GitHub release URL.
- Postinstall rewritten to probe for `bun` via pure `node:fs` instead of
  shelling out, so OpenClaw's `dangerous-exec` scanner accepts the tarball.
- `openclaw.plugin.json` cleaned up to use the real required fields (`id`,
  proper JSON Schema `configSchema`, `providers`); dropped the bogus
  `configPatch` block.

CLI-only release; engine v1.0.2 unchanged.

## [1.0.2] — 2026-04-15

Patch release. Engine v1.0.2.

## [1.0.0] — 2026-04-14

First stable release. Renamed from `@drakulavich/parakeet-cli`; the
`parakeet` command remains as a backward-compatible alias.

### Added
- Rust engine as a single binary — replaces `onnxruntime-node`, a separate
  Swift binary, and the `ffmpeg` runtime dependency.
- ~19× faster than Whisper on Apple Silicon (CoreML); ~2.5× faster on CPU
  (ONNX).
- 25 languages for speech-to-text; 107 languages for spoken language
  detection.
- OpenClaw skill: `openclaw plugins install @drakulavich/kesha-voice-kit`.
- "Did you mean?" command suggestion for typos.

### Migration from `@drakulavich/parakeet-cli`

```bash
bun remove -g @drakulavich/parakeet-cli
bun install -g @drakulavich/kesha-voice-kit
kesha install   # re-downloads engine + models
```

## [1.0.0-beta.5] — 2026-04-14

Final beta before the 1.0.0 rename / rewrite.
