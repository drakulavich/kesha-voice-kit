# Japanese TTS via FluidAudio 0.14.8 KokoroAne — Design (#492)

**Status:** approved (brainstorm), pending implementation plan
**Refs:** #492 (partial — ships `ja`; `hi`/`zh` remain open follow-ups)

## Problem

The darwin `system_kokoro` (FluidAudio) TTS path emits **noise** for non-Latin native-script
input (hi/ja/zh): the fork's Swift bridge hardcodes `KokoroAneManager(variant: .english, …)`,
so FluidAudio's English G2P is applied to Devanagari / kana-kanji / Han. #495 added a
fail-fast gate (`E_SCRIPT_UNSUPPORTED`) so this is a loud error today, not silent noise.

Spikes (recorded in #492 and the prior session) established:
- FluidAudio **v0.14.8** (latest *release*) exposes `KokoroAneVariant` cases
  **`english` / `spanish` / `japanese`** with per-variant G2P. So **Japanese is achievable
  on a released version** by selecting the variant by language.
- `hi`/`zh` KokoroAne variants exist only on FluidAudio's **unreleased dev HEAD** — pinning a
  shipped dependency to that is too fragile. They are deferred (hi is also reachable via the
  ONNX CharsiuG2P path with one remap rule; zh needs Kokoro-specific tone encoding — hard).

## Goal

Native Japanese TTS on the darwin FluidAudio Kokoro path: bump the fork to FluidAudio
0.14.8, select the `KokoroAne` variant by language (en/es/ja), preserve the `--rate`
patch, and unblock `ja` native script in kesha. `hi`/`zh` stay fail-fast.

### Non-goals
- `hi` and `zh` native-script synthesis (separate follow-ups; keep the #495 gate for them).
- Pinning FluidAudio to an unreleased dev commit.
- Changing the ONNX (Linux/Windows) TTS path. This is darwin `system_kokoro` only.
- Re-architecting the fork beyond what variant selection requires.

## Architecture — two repos, sequenced

Repo A (the fork) is a hard prerequisite: kesha can't bump its rev until the fork publishes
one. ~80% of the effort is in the fork's Swift bridge.

### Repo A — `drakulavich/fluidaudio-rs` (`/Users/anton/Personal/repos/fluidaudio-rs`)

Base branch: **`feat/fluidaudio-0.14.7-kokoro-ane-speed`** (rev `9ce32cc` — already carries the
`KokoroAneManager` migration + the `--rate` model-native-speed patch). NOT `forked-main`
(which lags at FluidAudio 0.14.5 and lacks the migration). Work on a new branch off it, e.g.
`feat/fluidaudio-0.14.8-multilingual-variants`.

1. **`Package.swift`** — `FluidAudio` `exact: "0.14.7"` → `exact: "0.14.8"`.
2. **`swift/FluidAudioBridge.swift`** — replace the hardcoded
   `KokoroAneManager(variant: .english, defaultVoice:)` (≈line 143) with **variant selection
   by language**:
   - Map language → `KokoroAneVariant`: `en → .english`, `es → .spanish`, `ja → .japanese`.
   - Cache one `KokoroAneManager` per variant (lazily created on first use); do not tear down
     the English manager when a Japanese request arrives. A small `[KokoroAneVariant: KokoroAneManager]`
     dictionary keyed by variant.
   - The language signal reaches the bridge via an explicit FFI parameter (preferred — see
     §FFI) rather than guessing from the voice id, so kesha stays the source of truth for
     language routing.
3. **FFI surface** (`swift/Kokoro_ffi.swift` + `src/ffi/bridge.rs` + `src/lib.rs`) — thread a
   `lang` argument through `fluidaudio_kokoro_synthesize` / `synthesize_kokoro` so the bridge
   picks the variant. Backward-compatible default: empty/unknown lang → `.english` (preserves
   today's behavior for en voices).
4. **Preserve `--rate`** — the model-native `speed` input must still feed the model for every
   variant, not just English. Verify against the 0.14.8 `KokoroAneManager.synthesize` signature
   (the patch may need re-applying if the API shifted between 0.14.7 and 0.14.8).
5. **Build + smoke** — `swift build`; a throwaway harness synthesizes one Japanese sentence
   (e.g. こんにちは) and confirms non-empty WAV. Spike-validate the 0.14.7→0.14.8
   `KokoroAneManager` API delta before finalizing the bridge.
6. Commit on the new branch, push to `origin`, record the new rev SHA.

### Repo B — kesha-voice-kit (`feat/ja-fluidaudio-kokoro` worktree)

1. **`rust/Cargo.toml`** — bump the `fluidaudio-rs` `rev` to the new fork commit; update the
   pinning comment (now FluidAudio 0.14.8, multilingual variant selection).
2. **`rust/src/tts/fluid_kokoro.rs`** — pass the resolved language to the binding's
   `synthesize_kokoro`/`synthesize_pcm` calls so the bridge selects the variant. The
   `ResolvedVoice::FluidKokoro` already carries `espeak_lang`; thread it through.
3. **Script gate** (`unsupported_native_script` / `ensure_script_supported`, #495) — remove the
   `ja` (kana/kanji) arm so Japanese native script is allowed; **keep `hi` (Devanagari) and
   `zh` (Han) blocked** with the existing `E_SCRIPT_UNSUPPORTED` fail-fast.
4. **Voices** (`rust/src/tts/voices.rs`, FluidKokoro catalog) — ensure a **male** Japanese
   voice is the default for `ja` (brand rule "DEFAULT TTS VOICES MUST BE MALE" — pick a `jm_*`
   voice, e.g. `jm_kumo`, validated by ear). Wire `default_voice_for_lang`/voice resolution on
   the `system_kokoro` path.
5. **Model assets** — KokoroAne fetches the Japanese variant's CoreML/G2P assets via
   FluidAudio's own downloader (HF `FluidInference/kokoro-82m-coreml`). Ensure this happens
   under the explicit `kesha install --tts` flow and never as a surprise download at synth time
   (the "NEVER AUTO-DOWNLOAD" rule). Document any new asset/size in the install path.

## Data flow (after)

```
kesha say --voice ja-jm_kumo "こんにちは"
  → fluid_kokoro::synthesize(text, "ja-jm_kumo", speed)
      → ensure_script_supported: ja now allowed
      → fluidaudio-rs synthesize_kokoro(text, voice="jm_kumo", lang="ja", speed)
          → FluidAudioBridge: KokoroAneManager(variant: .japanese) (cached)
              → FluidAudio 0.14.8 Japanese G2P → Kokoro → WAV
```

## Error handling

- `hi`/`zh` native script: unchanged fail-fast (`E_SCRIPT_UNSUPPORTED`) with the romanize/other-voice hint.
- Unknown/empty lang into the FFI: defaults to `.english` (no regression for en).
- Missing ja assets: the existing `kesha install --tts` hint path; never silently synthesize noise.

## Testing strategy

- **Fork:** `swift build` + a Japanese synth smoke (non-empty WAV) on the new branch before publishing the rev.
- **kesha (darwin only):**
  - ja round-trip: synthesize a Japanese sentence, transcribe with Parakeet, assert recognizable Japanese (the #492 evidence methodology) — gated to darwin `system_kokoro`.
  - audio-quality-check agent on the ja WAV (rate/RMS/clip/length).
  - script-gate test: `ja` native script now succeeds; `hi`/`zh` still error with `E_SCRIPT_UNSUPPORTED`.
- Full gate per CLAUDE.md: `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --features tts`, plus the build is `system_kokoro` (darwin) — validate with `cargo check --features system_kokoro` / a real darwin build.

## Rollout / linkage

Two PRs:
1. Fork PR in `drakulavich/fluidaudio-rs` (FluidAudio 0.14.8 + multilingual variant selection).
2. kesha-voice-kit PR: `Refs #492` (partial — ships ja; do NOT `Closes`, since hi/zh remain).
   After it lands, comment on #492 that `ja` is supported and hi/zh stay tracked.

## Open risks (validate during implementation)

- Exact `KokoroAneManager` init/`synthesize` API delta between 0.14.7 and 0.14.8 (drives the
  bridge edit + `--rate` re-apply).
- Whether multiple per-variant `KokoroAneManager` instances coexist cleanly (memory/ANE), or a
  single manager must be re-initialized on variant switch.
- Japanese asset download size/source and how it fits `kesha install --tts`.

---

## REVISION (2026-06-01): pivoted ja → zh

**Correction:** the brainstorm spike misread the FluidAudio source — it conflated
`KokoroAneVariant` with unrelated ASR/G2P language enums. The **resolved FluidAudio
0.14.8** `KokoroAneVariant` has exactly two cases: **`english` and `mandarin` (zh)** —
**no `japanese`, no `spanish`**. Verified against `.build/checkouts/FluidAudio/.../KokoroAne/KokoroAneConstants.swift`.

**Impact:** this FluidAudio-0.14.8 effort ships **Chinese (zh)**, not Japanese. The
`.mandarin` variant is fully functional (jieba + g2pw + bopomofo + erhua + tone sandhi +
pinyin dict; `ANE-zh/` bundle; default voice `zf_001`). FluidAudio handles Mandarin tones
in-engine — the part that was hard on the ONNX CharsiuG2P path (tone letters were OOV).

**Corrected design (supersedes the ja-specific details above):**
- Bridge variant map: **`zh → .mandarin`, everything else → `.english`** (en plus the
  Latin-script es/fr/it/pt, which already synthesize acceptably through the English G2P).
  No spanish/japanese variant exists to select.
- kesha script gate: **drop the `zh` (Han) arm**; **keep `hi` (Devanagari) AND `ja`
  (kana/kanji) fail-fast** — neither has a FluidAudio 0.14.8 KokoroAne variant.
- zh default voice: **`zh-zm_yunjian`** (male, per brand rule) — overrides the variant's
  `zf_001` (female) default. Verify `zm_yunjian` ships in the `ANE-zh/` pack during impl.
- `ja` and `hi` are deferred to a separate **ONNX CharsiuG2P** effort (spike: ja OOV=0
  clean, hi 1 remap rule) — they are not reachable via FluidAudio 0.14.8.

Linkage stays `Refs #492` (ships zh; ja/hi remain).

## Correction (2026-06-01): zh model staging — first-synth download is the norm

The B5 "Model assets" item above aspired to pre-fetch under `kesha install --tts` and
"never a surprise download at synth time." Implementation reality: the FluidAudio
`system_kokoro` path **already** leaves its model graph + `af_heart` to a first-synth,
FluidAudio-owned download (`models.rs::download_tts` notes `kokoro_manifest()` is empty for
this path). The Mandarin `.mandarin` variant fetches its **nested** `ANE-zh/` bundle the same
way; kesha cannot pre-stage it (FluidAudio owns that layout), and pre-fetching a large
Mandarin bundle at install for users who never use zh would be worse. So zh is **consistent
with the existing first-synth model download** for this path, not a new rule violation
(Greptile #516 P1). A general "warm all TTS models at install" is a separate possible
enhancement (would also pre-fetch the en model graph), out of scope here.
