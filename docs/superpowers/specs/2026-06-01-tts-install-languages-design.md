# Language-scoped TTS install — design

**Date:** 2026-06-01
**Status:** Approved (brainstorm) — ready for implementation plan
**Issue:** TBD (open before implementation)

## Problem

`kesha install --tts` and the `kesha init` TTS step are a single boolean. They
unconditionally download **every** TTS model: Kokoro (English + the multilingual
graph) **and** Vosk-TTS Russian — roughly 990 MB. A user who only wants English
still pays Vosk's ~937 MB; a Russian-only user still pays Kokoro's ~326 MB.

We want the install to take **language codes**, downloading only the models those
languages need — modelled on `npx playwright install chromium firefox`, where the
caller names what they want.

## Goals

- `kesha install --tts en ru` downloads only the packs those languages need.
- Bare `kesha install --tts` downloads **English only** (the smallest useful default).
- `kesha init` collects languages through a multi-select checkbox TUI.
- Requesting a language unavailable on the current platform is a **hard error** that
  downloads nothing.
- Re-running install is **additive** — it adds the new language's packs and never
  prunes existing ones.

## Non-goals (YAGNI)

- Pruning / uninstalling languages. Install is additive only.
- `macos-*` AVSpeech voices. They need no download and are never "installed"
  (see "AVSpeech is ambient" below).
- A `--tts <lang>:<engine>` override syntax. The data model anticipates multiple
  downloadable models per language, but the override parser is **deferred** until a
  language actually has two downloadable models (today none do).
- `kesha status` reporting which languages are installed. Possible follow-up.

## Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| CLI syntax | Positional, Playwright-style: `kesha install --tts en ru` |
| Bare `--tts` | English only (~326 MB) |
| Unsupported language on platform | Hard error, download nothing |
| `init` collection | `@clack/prompts` multi-select TUI, platform-aware, `en` pre-checked |
| Re-run semantics | Additive (downloads only missing packs; never prunes) |
| AVSpeech / `macos-*` | Excluded from install entirely (ambient on macOS) |
| Multiple models per language | Many-to-many data model now; override syntax deferred |
| Language↔platform source of truth | Rust engine, exposed via `--capabilities-json` |

## The language ↔ model relationship

Two distinct shapes, handled differently:

**Many languages → one model.** The Kokoro graph (`model.onnx`) serves `en`, `es`,
`fr`, `hi`, `it`, `ja`, `pt`, `zh` from one shared file plus per-language voice
`.bin`s. Selecting multiple Kokoro languages must download the graph **once** and
stage each language's voices. The download layer dedups the shared graph.

**One language → multiple models.** Today every language is served by a downloadable
neural model *and* (on macOS) by AVSpeech system voices. The forward-looking case is
two *downloadable* models for one language (e.g. if Kokoro ever ships Russian, `ru`
would have both Kokoro and Vosk).

### AVSpeech is ambient, not installed

`install --tts` manages **downloadable model packs only**. AVSpeech / `macos-*`
voices are part of macOS, need no download, and are therefore never resolved by
install. This kills the present-day ambiguity:

- `kesha install --tts ru` on macOS **always downloads Vosk** (~937 MB), regardless
  of whether Milena (AVSpeech) is present.
- Milena and other `macos-*` voices remain usable at synth time via
  `--voice macos-...` with zero install.

### Resolution model

The registry is **many-to-many (language ↔ engine)**, even though every language's
engine list is currently a singleton:

```jsonc
"tts": { "languages": [
  { "code": "en", "engines": ["kokoro"] },
  { "code": "ru", "engines": ["vosk"] },
  { "code": "es", "engines": ["kokoro"] }   // darwin-arm64 only
]}
```

- `--tts <lang>` resolves to the language's **default engine** = `engines[0]`
  (maintainer-curated order). Today every list has length 1, so it is always
  unambiguous.
- When a list gains a second entry, the override token `--tts <lang>:<engine>` is
  introduced. The parser is not built until then — but capabilities and the registry
  already express the many-to-many shape, so the later addition is a registry edit,
  not a re-architecture.

### Language → pack table (today)

| code | engine | packs downloaded | platform | approx |
|---|---|---|---|---|
| `en` | Kokoro | shared graph + EN voice(s) | all | ~326 MB |
| `ru` | Vosk-TTS | model + dictionary + BERT + vocab | all | ~937 MB |
| `es fr hi it ja pt zh` | FluidKokoro (ANE) | shared graph (auto) + that language's voice `.bin` | **darwin-arm64 only** | small per-language |

## Architecture

Three layers. The language↔platform↔engine table lives in **one place** — the Rust
engine — and is exposed via `--capabilities-json`. The TS layer consumes it and never
hardcodes a parallel table (per the CLAUDE.md "validate against `--capabilities-json`"
rule).

### Layer 1 — Capabilities (Rust, source of truth)

`rust/src/capabilities.rs`:

- Add a structured `tts` field carrying the language rows shown above
  (`{ code, engines }` per language), populated by `#[cfg]`:
  - `en`, `ru` whenever `feature = "tts"`.
  - `es`, `fr`, `hi`, `it`, `ja`, `pt`, `zh` added under
    `system_kokoro + macos + aarch64`.
- Bump `protocolVersion` `2 → 3`.
- `EngineCapabilities` (TS, `src/engine.ts`) mirrors the new field.

The flat `features` array keeps its existing `tts*` entries unchanged for
back-compat; the new structured field is additive.

### Layer 2 — Engine install CLI (Rust)

`rust/src/main.rs` + `rust/src/cli/install.rs`:

- `kesha-engine install --tts` changes from `bool` to accept zero-or-more language
  codes (`clap` `num_args(0..)`). Present with no values → `["en"]`; absent → no TTS.
- Validate each requested code against `get_capabilities()` TTS languages. Unknown or
  platform-unavailable code → hard error listing the supported codes, **download
  nothing**.
- `models::download_tts(no_cache)` → `download_tts(langs, no_cache)`:
  - Refactor the flat `ANE_KOKORO_VOICES` const into a language-prefix lookup
    (`a`/`b` → en, `e` → es, `f` → fr, `h` → hi, `i` → it, `j` → ja, `p` → pt,
    `z` → zh) so each language stages only its own voices.
  - If any Kokoro language is selected: download the shared graph once on the ONNX
    path (rely on FluidAudio auto-download on the darwin `system_kokoro` path), and
    stage only the selected languages' voices.
  - If `ru` is selected: `vosk_ru_manifest()`.
- **Additive** is free: `download_verified` already short-circuits cached files that
  match their pinned SHA, so re-runs fetch only missing packs. No pruning logic.

### Layer 3 — TS CLI

`src/cli/install.ts`:

- `kesha install --tts en ru`: `--tts` enables TTS; the positional args (`args._`)
  are the language list. Bare `--tts` → `["en"]`. Positionals present without `--tts`
  → error ("language codes require `--tts`").
- Validate the requested languages against `getEngineCapabilities()` TTS languages
  **before** forwarding to the engine (hard error, nothing downloaded).
- Forward the language list verbatim to `kesha-engine install --tts en ru`.

`src/engine-install.ts`:

- `InstallOptions.tts: boolean` → `ttsLangs?: string[]`.
- Build the engine `install` args from the language list.
- TTS warm-up (`warmDarwinKokoro`) runs when the selected set includes a Kokoro
  language; otherwise skip it.

`src/cli/init.ts`:

- The TTS step becomes a `@clack/prompts` **multi-select** over the capabilities'
  TTS languages (platform-aware — only installable codes are shown), with `en`
  pre-checked. An empty selection skips TTS.
- The existing non-TTY branch (`runNonInteractive`) keeps printing suggested commands
  (now `kesha install --tts en …`); no TUI is attempted without a TTY.
- `InitSelection` carries the selected language list through to `performInstall`.

### Plan rendering

`src/install-plan.ts`:

- `KOKORO_FILES` / `VOSK_FILES` become per-language groups.
- `renderInstallPlan` takes the language list and sums only the selected packs (with
  the shared Kokoro graph counted once), showing a per-language size breakdown.

## Dependencies

- Add `@clack/prompts` (runs under Bun) for the `init` multi-select TUI.

## Error handling

- Unknown / platform-unavailable language → hard error naming the bad code and listing
  supported codes; nothing downloads. Enforced in the engine (authoritative) and
  surfaced earlier in TS via capabilities for a faster, friendlier message.
- Positionals without `--tts` → actionable usage error.
- Engine/model download failures keep the existing contextual messages.

## Testing

**Rust:**
- `download_tts` language → manifest partition: `en` → Kokoro packs only, `ru` → Vosk
  only, `es` → ANE es voices only; multiple Kokoro languages share one graph.
- Capabilities lists the expected TTS language rows per `#[cfg]` (en/ru everywhere;
  es…zh only under `system_kokoro + macos + aarch64`).
- Install validation rejects unknown and platform-unavailable codes, downloading
  nothing.
- Run the `audio-quality-check` agent after the `rust/src/tts/**` changes.

**TS:**
- `install` arg parsing: positionals → languages; bare `--tts` → `["en"]`; positionals
  without `--tts` → error.
- Validation against capabilities (mock `getEngineCapabilities`).
- `init` multi-select selection → correct `install` args; empty selection → skip TTS;
  non-TTY → printed suggestions.

## Verification

- `bun test && bunx tsc --noEmit`
- `cd rust && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --features tts`
- `cargo check --features coreml --no-default-features` (backend module + capabilities changed)
- Confirm the build-engine feature matrix still mirrors cargo defaults (no new default
  feature added, so no matrix change expected — verify with the
  `ci-feature-matrix-auditor` before any release).

## Open items before implementation

- Open a GitHub issue and tag it `WIP`; fill the issue number into the header and use
  `Closes #N` in the PR.
- `@clack/prompts` is the only new runtime dependency; verify it installs cleanly under
  Bun during the first implementation step.
