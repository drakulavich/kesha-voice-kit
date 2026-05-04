# Changelog

All notable changes to `@drakulavich/kesha-voice-kit` are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

CLI and engine versions are **decoupled** — see `CLAUDE.md` for details. Tags
with a `-cli` suffix are CLI-only patches that reuse the previous engine
binary.

## [Unreleased]

## [1.7.0] (unreleased)

### Added
- **Russian abbreviation auto-expansion for `ru-vosk-*` voices.** Detects 2–5 letter all-uppercase Cyrillic tokens and reads them letter-by-letter via the embedded letter-name table. Stop-list for common short words (ОН, МЫ, КАК, ЧТО, …) prevents false positives. Tokens containing Ъ/Ь are passed through literally. Opt-out via `--no-expand-abbrev` flag. Closes [#232](https://github.com/drakulavich/kesha-voice-kit/issues/232).
- **SSML `<say-as interpret-as="characters">…</say-as>` honored on the Russian Vosk path.** Always wins, regardless of `--no-expand-abbrev` setting. Other `interpret-as` values (cardinal, ordinal, date, …) continue to warn and strip.
- **Engine `--capabilities-json` reports `tts.ru_acronym_expansion: true`** in the `features` array for compatibility with the TS CLI gate. The CLI uses this to conditionally forward `--no-expand-abbrev` only to engines that support it.

## [1.6.0] — 2026-04-30

Engine release. Adds OGG/Opus voice-note output, restores Windows MSVC builds via a vendored vosk-tts crate, and tightens the Opus hot path. CLI surface is unchanged — npm consumers get the new format flag automatically once the engine binary updates.

### Added
- **`kesha say --format ogg-opus`** — produces OGG/Opus voice notes (mono, 24 kHz @ 32 kbps by default) instead of WAV. The output file is the messenger-friendly format consumed by Telegram `sendVoice` and similar APIs. New flags `--bitrate` and `--sample-rate` tune the encoder; format is also inferred from `--out` extension (`.ogg` / `.opus` / `.oga`). All four engine paths (Kokoro plain/SSML, Vosk-TTS plain/SSML, AVSpeech) flow through the new encoder. WAV output remains the default and is byte-exact with the previous code path. (#224, closes #223)

### Changed
- **Vendored `vosk-tts-rs`** into `rust/vendor/vosk-tts` so Windows builds compile under MSVC again — upstream's `tonic`/`prost` chain pulled in MinGW-only deps that broke the Windows engine artifact. Behaviour and the public Rust API are unchanged. (#225, closes #216)
- npm `homepage` field now points at the project landing page (`https://drakulavich.github.io/kesha-voice-kit/`) instead of the README anchor.

### Performance
- **OGG/Opus encoder hot path:** dropped a redundant `pcm_buf.copy_from_slice` per 20 ms frame (saves N memcpys for an N-frame utterance), and right-sized the output `Vec::with_capacity` from `samples.len()` (≈6× over) to `bitrate × duration / 8 + 4 KiB`. (#226)

## [1.5.0] — 2026-04-29

First engine release since v1.4.1. Catches the binary up to the engine source
that's been sitting in `main` since #209/#211/#214. CLI 1.4.4 features
(Vosk-aware status, male English default, RU darwin auto-route) become
functional once this engine binary is installed.

### Added
- **Vosk-TTS for Russian** (multi-speaker, 5 baked-in voices: `ru-vosk-{f01,f02,f03,m01,m02}`). Uses `vosk-tts-rs` directly — BERT prosody + dictionary G2P, no espeak-ng / no separate G2P model. Default Russian voice on non-darwin platforms is now `ru-vosk-m02` (male, per the brand-voice rule); darwin keeps `Milena` for the zero-install AVSpeech path. (#214, closes #210)
- **misaki-rs G2P for English** in Kokoro — embedded lexicon + POS tagging, OOV words letter-spell. Replaces the ONNX ByT5-tiny G2P pipeline for English specifically. Russian is now handled inside Vosk-TTS. (#211)

### Changed
- **`kesha install --tts`** now downloads Kokoro + Vosk-TTS (~990 MB total) instead of Kokoro + Piper-RU + ONNX G2P. Disk savings on top of removing the FP32 G2P weights.
- **`kesha status`** reports the `vosk-ru` cache directory and the 5 Vosk speakers; Piper / G2P rows removed.
- Russian auto-routing: darwin → AVSpeech `Milena` (zero install); Linux/Windows → `ru-vosk-m02`. (#209, #214)

### Removed
- **Piper-RU** as the Russian backend. Old voice ids (`ru-denis`, `ru-irina`, etc.) no longer resolve. Migration: pass `--voice ru-vosk-m02` (default), or any of `ru-vosk-{f01,f02,f03,m01,m02}`. macOS users can also use `--voice macos-com.apple.voice.compact.ru-RU.Milena` (no model download).
- **CharsiuG2P (ONNX ByT5-tiny)** removed — the model files (`models/g2p/byt5-tiny/*`) are no longer downloaded. Existing caches are dead weight; `rm -rf ~/.cache/kesha/models/{g2p,piper-ru}` to reclaim space.

### Breaking changes
- Russian voice ids changed (`ru-denis` → `ru-vosk-m02`). The change is in source since #214; v1.5.0 is when the engine binary actually enforces it.
- `kesha install --tts` cache layout changed: `models/vosk-ru/` replaces `models/piper-ru/` and `models/g2p/`.

### Internal
- `protoc` install pulled into a reusable composite action (`.github/actions/install-protoc`) shared across `ci.yml`, `rust-test.yml`, and `build-engine.yml`.
- New CI agents: `audio-quality-check` (post-commit WAV stats sanity check) and `ci-feature-matrix-auditor` (verifies every cargo default feature appears in every build-engine matrix row).
- `rust/src/tts/kokoro.rs` — 4 pipeline bugs fixed alongside the misaki-rs swap (#211).

### Upgrade
```bash
bun add -g @drakulavich/kesha-voice-kit@latest
kesha install              # engine v1.5.0 (~22 MB)
kesha install --tts        # Kokoro + Vosk-RU (~990 MB; dedupe with prior cache happens automatically)
```

If you had `models/piper-ru/` or `models/g2p/` in your cache from a previous install, they're orphaned now — `rm -rf ~/.cache/kesha/models/{g2p,piper-ru}` to reclaim ~700 MB.

## [1.4.4] — 2026-04-29

### Changed
- Default voice for English auto-routing flipped from `en-af_heart` (female) to
  `en-am_michael` (male) to match Kesha's brand voice. Pass `--voice` to
  override. (#211)
- `kesha status` reports the `vosk-ru` cache directory and lists Vosk-TTS
  speaker ids (`ru-vosk-{f01,f02,f03,m01,m02}`) instead of the Piper layout.
  Aligns the CLI with the engine work queued for the next engine release.
  (#214)
- Russian auto-routing on darwin now picks AVSpeech `Milena` (zero install);
  Linux/Windows fall through to `ru-vosk-m02`. (#209, #214)

### Internal
- `protoc` install pulled into a reusable composite action and shared across
  `ci.yml`, `rust-test.yml`, and `build-engine.yml`.
- `actions/setup-node` bumped 4 → 6. (#215)
- Raycast extension `CHANGELOG.md` tracked in repo. (#206)

CLI-only release; engine v1.4.1 unchanged. Engine source in `main` carries the
Vosk-TTS / misaki-rs / AVSpeech-routing changes (#209, #211, #214) which will
ship with the next engine bump — Linux/Windows users hitting `ru-vosk-m02`
auto-routing today will get an "unknown voice" error until that release.

## [1.4.3] — 2026-04-24

### Changed
- README trimmed from 247 → 128 lines. Advanced sections (VAD, TTS, OpenClaw
  integration, air-gapped model mirror) moved into dedicated pages under
  `docs/` with one-line pointers from the README. (#203)

CLI-only release; engine v1.4.1 unchanged.

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
