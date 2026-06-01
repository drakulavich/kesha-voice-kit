# Language-scoped TTS install — design

**Date:** 2026-06-01
**Status:** Approved (brainstorm) — ready for implementation plan
**Issue:** [#517](https://github.com/drakulavich/kesha-voice-kit/issues/517)

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
// example on the ONNX build (Linux/Windows/macOS-without-system_kokoro)
"tts": { "languages": [
  { "code": "en", "engines": ["kokoro"] },
  { "code": "es", "engines": ["kokoro"] },  // also fr, it, pt
  { "code": "ru", "engines": ["vosk"] }
  // hi, ja, zh appear only on the darwin-arm64 system_kokoro build
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

Availability differs by build. The **ONNX build** (Linux, Windows, macOS without
`system_kokoro`) covers `en es fr it pt ru`. The **`system_kokoro` build**
(darwin-arm64) covers `en es fr hi it ja pt zh ru`. `hi ja zh` exist **only** on the
darwin ANE path; `es fr it pt` exist on **both** (via CharsiuG2P on ONNX, ANE on darwin).

| code | engine | packs downloaded | available on | approx |
|---|---|---|---|---|
| `en` | Kokoro | shared graph + `am_michael` | all builds | ~326 MB |
| `es fr it pt` | Kokoro (ONNX) / FluidKokoro (ANE) | shared graph + that language's voice `.bin`; **+ CharsiuG2P (3 files, ~30 MB, shared) on the ONNX path** | all builds | ~30 MB (G2P, once) + tiny per-voice; graph shared |
| `hi ja zh` | FluidKokoro (ANE) | shared graph (auto) + that language's ANE voice `.bin` | **darwin-arm64 only** | tiny per-language |
| `ru` | Vosk-TTS | model + dictionary + BERT + vocab | all builds | ~937 MB |

Pack dependencies on the **ONNX build** (`kokoro_manifest()`):
- The Kokoro graph `model.onnx` (~326 MB) is shared by `en es fr it pt` — download once
  if *any* of them is selected.
- `en` needs no G2P (English uses the embedded `misaki-rs` lexicon).
- `es fr it pt` each need their voice `.bin` **and** the shared CharsiuG2P byt5-tiny pack
  (3 files). Download G2P once if any of `es fr it pt` is selected.

Pack dependencies on the **`system_kokoro` build** (darwin-arm64):
- `kokoro_manifest()` is empty — the graph auto-downloads into FluidAudio's cache on
  first synth. Each Kokoro language stages only its own voice `.bin`(s) from
  `ANE_KOKORO_VOICES` (today `stage_ane_kokoro_voices` stages the entire catalog).

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
  - `es`, `fr`, `it`, `pt` added on **both** TTS builds — under
    `not(all(system_kokoro, macos, aarch64))` (ONNX/CharsiuG2P) **and** under
    `all(system_kokoro, macos, aarch64)` (ANE).
  - `hi`, `ja`, `zh` added **only** under `all(system_kokoro, macos, aarch64)`.
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
- `models::download_tts(no_cache)` → `download_tts(langs, no_cache)`. Build the
  manifest from the selected languages:
  - **ONNX path** (`kokoro_manifest()` non-empty): split `kokoro_manifest()` into
    addressable pieces — the shared graph, `en`'s `am_michael`, the shared CharsiuG2P
    pack, and each multilingual voice (`es`→`em_alex`, `fr`→`ff_siwis`, `it`→`im_nicola`,
    `pt`→`pm_alex`). Include the graph if any of `en es fr it pt` is selected; include
    G2P if any of `es fr it pt` is selected; include each selected language's voice.
  - **`system_kokoro` path** (darwin-arm64): refactor the flat `ANE_KOKORO_VOICES` const
    into a language-prefix lookup (`a`/`b` → en, `e` → es, `f` → fr, `h` → hi, `i` → it,
    `j` → ja, `p` → pt, `z` → zh) so `stage_ane_kokoro_voices` stages only the selected
    languages' voices. (`af_heart` stays excluded.)
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

- Issue [#517](https://github.com/drakulavich/kesha-voice-kit/issues/517) opened and
  tagged `WIP`; use `Closes #517` in the PR.
- `@clack/prompts` is the only new runtime dependency; verify it installs cleanly under
  Bun during the first implementation step.
