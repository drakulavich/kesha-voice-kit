# Bidirectional Voice (TTS) for LLM Agents

**Date**: 2026-04-16
**Status**: Draft
**Scope**: New Rust TTS module, new TypeScript `kesha say` subcommand, opt-in model install, CI matrix extension

## Problem

Kesha Voice Kit gives LLM agents *ears* (speech-to-text + language detection) but not a *mouth*. When an OpenClaw agent receives a voice message on Telegram/WhatsApp/Slack, it transcribes and replies in text — even if the natural medium is voice. For a voice-first assistant, that is a one-way mirror.

[FluidAudio](https://github.com/FluidInference/FluidAudio) — already used for ASR — offers high-quality local TTS via Kokoro (neural, 9 languages, SSML, Apple Neural Engine). Silero TTS (ONNX, pure Rust-friendly) fills the gap for Russian and other Slavic languages that Kokoro does not cover. Together they let Kesha speak back with neural quality, fully offline, without adding Python or ffmpeg dependencies.

## Solution

Add a `kesha say` subcommand backed by two TTS engines in the existing `kesha-engine` Rust binary:

- **Kokoro-82M** for EN/ES/FR/IT/JA/ZH/PT/HI and other Kokoro languages. Apple Silicon uses FluidAudio (CoreML/ANE); other platforms use `ort` (ONNX).
- **Silero TTS** for Russian (and optionally Ukrainian) on all platforms via `ort` (no CoreML variant exists).

Routing is automatic by language (via the `NLLanguageRecognizer` already bundled on macOS, with a language-code → default-voice table), with `--voice`/`--lang` overrides for explicit control. Models are opt-in (`kesha install --tts`) to preserve the "small footprint" identity of the default install.

## Constraints

- CLI ergonomics mirror existing ASR side: stdout = result, stderr = progress/errors, pipe-friendly, deterministic exit codes
- "NEVER auto-download models" rule is preserved — first `kesha say` without installed models shows an actionable error
- No new system dependencies (no ffmpeg, no Python)
- Cross-platform parity where possible: users on Linux/Windows get neural Russian TTS (Silero), not just English
- Single binary, single install flow, single `kesha status` output — no second CLI or package
- Backwards-compatible: today's `kesha` usage is unchanged

## Architecture

```
                 ┌─────────────────────────┐
kesha say "text" │  kesha CLI (TypeScript) │
                 │   src/say.ts (new)      │
                 └────────────┬────────────┘
                              │ subprocess (text via stdin)
                              ▼
                 ┌─────────────────────────┐
                 │  kesha-engine (Rust)    │
                 │   crates/tts/ (new)     │
                 └────┬───────────────┬────┘
                      │               │
        Apple Silicon │               │ Other platforms
                      ▼               ▼
             ┌──────────────┐  ┌──────────────┐
             │  FluidAudio  │  │     ort      │
             │  (Kokoro)    │  │  (Kokoro +   │
             │              │  │   Silero)    │
             └──────────────┘  └──────────────┘
```

- **TypeScript (`src/say.ts`)** — argument parsing, language auto-detect via `NLLanguageRecognizer`, voice routing policy, stdout/stderr hygiene, subprocess plumbing
- **Rust (`rust/crates/tts/`)** — model loading, tokenization/phonemization, inference, WAV muxing
- **Backend selection** — CoreML on Apple Silicon when available for Kokoro; `ort` everywhere for Silero and as cross-platform fallback
- **G2P (grapheme-to-phoneme)** — Kokoro expects IPA phoneme tokens, not raw text. v1 uses **statically-linked `espeak-ng`** (~15MB added to the Rust binary, no user-visible system dependency). Follow-up [issue #123](https://github.com/drakulavich/kesha-voice-kit/issues/123) tracks replacing it with a native ONNX G2P for parity with FluidAudio's CoreML G2P on Apple Silicon.

## CLI Surface

```bash
kesha say "Hello, world"                 # auto-route EN → Kokoro
kesha say "Привет, мир"                  # auto-route RU → Silero
kesha say --voice en-af_heart "Hi"       # explicit voice
kesha say --lang ru "text"               # force language (skip detection)
kesha say --out reply.wav "text"         # write to file; stdout stays clean
kesha say --format wav "text"            # wav (default); ogg/mp3 future
kesha say --rate 1.1 "text"              # speed 0.5–2.0 (Kokoro only v1)
echo "long text" | kesha say             # stdin if no positional arg
kesha say --list-voices                  # enumerate installed voices
kesha install --tts                      # opt-in TTS model download (~150MB default)
kesha install --tts --voice ru           # Russian pack only (~60MB)
kesha install --tts --voice en,ru,fr     # specific packs
kesha install --tts --all                # every Kokoro + Silero voice (~1GB+)
kesha status                             # existing; extended with TTS voices
kesha uninstall --voice ru-silero-baya   # remove a voice
```

### Voice Routing Rules (in order)

1. `--voice <id>` → use directly; fail if not installed
2. `--lang <code>` → pick default voice for that language from the table below
3. Auto-detect via `NLLanguageRecognizer` on the input text
4. Confidence < 0.5 **or** detected language has no installed voice → error with actionable hint

### Default Voice Table (illustrative)

| Language | Engine | Voice | Source |
|---|---|---|---|
| en | kokoro | af_heart | FluidInference/Kokoro-82M |
| es | kokoro | ef_dora | FluidInference/Kokoro-82M |
| fr | kokoro | ff_siwis | FluidInference/Kokoro-82M |
| ja | kokoro | jf_alpha | FluidInference/Kokoro-82M |
| zh | kokoro | zf_xiaoxiao | FluidInference/Kokoro-82M |
| pt | kokoro | pf_dora | FluidInference/Kokoro-82M |
| hi | kokoro | hf_alpha | FluidInference/Kokoro-82M |
| it | kokoro | if_sara | FluidInference/Kokoro-82M |
| ru | silero | v4_ru/baya | snakers4/silero-models (ONNX export) |
| uk | silero | v4_uk/mykyta | snakers4/silero-models (ONNX export, optional) |

### Stdout/Stderr Discipline

- stdout: raw WAV bytes (or file path if `--out` given and `--print-path` set)
- stderr: progress, warnings, errors
- Exit codes: 0 success, 1 model/voice not installed, 2 bad input, 3 language detection low confidence, 4 synthesis failure, 5 text too long (>5000 chars soft limit)

## Model Install & Storage

Opt-in, curated defaults, explicit `--all` for the power user.

```
~/.cache/kesha/
├── engine/bin/kesha-engine              (existing)
├── asr/parakeet-tdt-v3/                 (existing)
├── langid/ecapa-voxlingua107/           (existing)
└── tts/                                 (new)
    ├── kokoro-82m/
    │   ├── model.onnx                   (shared across voices)
    │   ├── model.mlpackage/             (CoreML variant, Apple Silicon only)
    │   └── voices/
    │       ├── af_heart.bin
    │       └── ef_dora.bin
    ├── silero-v4-ru/
    │   ├── model.pt.onnx
    │   └── voices/{baya,aidar,kseniya,xenia,eugene}.json
    └── manifest.json                    (names, sizes, SHA256, versions)
```

Model resolution order: `$KESHA_MODELS_DIR` → `~/.cache/kesha/tts/` → error with install hint.

`kesha-engine --capabilities` advertises `{asr: true, tts: {engines: ["kokoro","silero"], voices: [...]}}` so the TypeScript layer knows what is available without probing.

First-run UX for a Russian user with no TTS installed:

```
$ kesha say "Привет, мир"
error: no TTS voices installed.
hint:  kesha install --tts           # Kokoro EN + Silero RU (~150MB)
       kesha install --tts --voice ru  # Russian only (~60MB)
```

## Data Flow — `kesha say "Привет, мир" > out.wav`

1. **kesha CLI (`src/say.ts`)**
   - Parse args; if no text positional, read stdin
   - Route: `--voice` → skip detection; `--lang` → skip detection; else `NLLanguageRecognizer(text)`
   - Validate voice installed (read `manifest.json`); if not → error + hint, exit 1
   - Spawn `kesha-engine say --voice <id> --format wav` with text on stdin
2. **kesha-engine (Rust)**
   - Load engine + voice from `~/.cache/kesha/tts/`
   - Tokenize → phonemize (Kokoro: misaki-style; Silero: native)
   - Inference: Kokoro + Apple Silicon → FluidAudio (CoreML/ANE); Kokoro + Linux/Windows → `ort`; Silero → `ort` on all platforms
   - Post: resample to 24kHz mono f32 → WAV mux (`hound` crate)
   - Write raw WAV to stdout
3. **kesha CLI**
   - Pipe engine stdout → user's stdout (zero-copy)
   - Forward engine exit code

## Error Handling

| Code | Condition | Message (stderr) |
|---|---|---|
| 0 | Success | — |
| 1 | Model/voice not installed | `voice 'ru-silero-baya' not installed. run: kesha install --tts --voice ru` |
| 2 | Bad input (empty, unknown flag, unknown voice anywhere) | `unknown voice 'xx-yy'. run: kesha say --list-voices` |
| 3 | Language detection low confidence | `could not detect language (confidence 0.31). use --lang or --voice` |
| 4 | Engine crash / synthesis failure | `synthesis failed: <engine stderr>` |
| 5 | Text exceeds soft limit | `text exceeds 5000 chars. split into chunks or use --allow-long` |

All errors are human-readable, name what failed, explain why when non-obvious, and include the exact command to recover (per existing CLAUDE.md rule).

## Testing

| Layer | What | Where |
|---|---|---|
| Unit (Rust) | Voice selection, WAV muxing, phonemizer output shape | `rust/crates/tts/src/**` |
| Unit (TS) | Language routing policy, flag parsing, error messages | `src/__tests__/say.test.ts` |
| Integration | Fixture text → synthesize → verify non-silent WAV header + duration bounds | `tests/integration/say.test.ts` |
| Determinism | Synthesize fixed text + seed; hash first 100ms of PCM; fail on drift > N samples | `tests/integration/say-golden.test.ts` |
| Cross-platform | CI matrix: macOS arm64 (CoreML), Linux x64 (ONNX), Windows x64 (ONNX) | Extend existing `ci.yml` |
| Smoke | `make smoke-test` adds `kesha say "hello" > /tmp/out.wav; file /tmp/out.wav \| grep WAVE` | `scripts/smoke-test.ts` |

Perceptual quality is manual QA on a handful of fixture texts per language.

## Staged Rollout

Three milestones, each a mergeable PR series.

**M1 — Kokoro EN only, WAV out** (plumbing PR)
- Rust `say` subcommand, ONNX path only (no FluidAudio yet)
- TS CLI `kesha say`, `--voice`, `--lang`, `--out`, `--list-voices`, stdin support
- `kesha install --tts` for Kokoro only
- CI matrix on all three OSes
- Ships `af_heart` voice
- Validates: CLI contract, install flow, cross-platform `ort` build, stdout hygiene

**M2 — FluidAudio path on Apple Silicon**
- Kokoro via FluidAudio/CoreML on macOS arm64; `ort` elsewhere
- Benchmark vs ONNX path; document real-time-factor delta
- Validates: backend selection logic parity with ASR side

**M3 — Silero RU (+ optional UK) + auto-routing**
- Silero engine in Rust
- `NLLanguageRecognizer` integration in TS for language → voice routing
- `kesha install --tts` default set expands to Silero RU
- Russian demo in README; update benchmark section
- Validates: multi-engine routing, non-English showcase

After M3, v1 of bidirectional voice is complete.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Kokoro ONNX on Linux CI slow/flaky | Ship M1 with `--rate` disabled if `ort` non-determinism bites; add `--deterministic` seed if needed |
| Silero ONNX conversion quality drift vs. reference PT model | One-time manual comparison vs. upstream PT; pin the ONNX repo + SHA256 |
| Cold-start latency hurts agent UX | Acknowledged non-goal for v1; daemon mode tracked separately. Document cold-start time in README so users aren't surprised |
| Model sizes balloon past "small binary" brand | TTS is opt-in via `--tts`; default install unchanged. README calls this out |
| `NLLanguageRecognizer` low confidence on short replies ("ok", "yes") | Fall through to English default rather than failing; log to stderr in `--verbose` |

## Non-Goals (v1)

Tracked for future work — not in scope for this spec.

- **SSML parsing** — see [issue #122](https://github.com/drakulavich/kesha-voice-kit/issues/122)
- **Custom model mirror (`KESHA_MODEL_MIRROR`)** — see [issue #121](https://github.com/drakulavich/kesha-voice-kit/issues/121)
- **Daemon/server mode** — persistent process to amortize cold-start for agent workloads
- **Streaming output** — chunked audio during synthesis (needed for low-latency live replies)
- **Voice cloning** — FluidAudio's PocketTTS supports it; not wired up
- **OGG/Opus, MP3 output** — WAV only in v1
- **OpenClaw TTS skill adapter** — deferred until OpenClaw's TTS plugin contract is pinned down; standalone CLI ships first

## Public API

Mirror ASR's `./core` export:

```typescript
import { say, downloadTts } from "@drakulavich/kesha-voice-kit/core";

await downloadTts({ voices: ["en", "ru"] });        // install TTS models
const wavBytes = await say("Привет, мир");          // auto-route → Silero RU
const wavBytes = await say("Hi", { voice: "en-af_heart" });
await say("text", { out: "reply.wav" });            // write to file
```
