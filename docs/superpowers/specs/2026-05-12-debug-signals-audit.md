# Debug-signal collection audit

**Date:** 2026-05-12
**Maintainer:** drakulavich
**Goal:** Identify blind spots in the project's `KESHA_DEBUG` / `--debug` / `dtrace!` / `log.debug` instrumentation. Audit only — no fixes in scope.

## Principles used as the yardstick

1. **Failures observable at the boundary.** When `say` returns "no audio" or `transcribe` returns an empty string, the user should be able to see — without changing flags or re-running — what was passed to the synth (text length, IPA, voice path, format) and what the engine reported back (sample count, exit code). A failure message without those facts is a puzzle, not a diagnostic.

2. **No magic in failures.** Heuristics that silently flip behaviour (VAD `Auto` mode, capability-flag drops, format inference from `--out` extension, all-silence VAD fallback) must announce themselves under `--debug` at minimum — and without a flag whenever the heuristic has a user-visible side effect.

3. **One trace per boundary, not per sample.** `dtrace!` points belong at module boundaries: process spawn, ONNX session load, model open, sidecar exec. Not inside inference loops (per-frame VAD probabilities, per-token Kokoro inference). The current discipline is right — extend it, don't move it.

4. **Dedup global, not per-call.** `tts::warn::warn_once` dedups via `Mutex<HashSet>` for the whole process. `ssml::parse()` dedups via a local `HashSet` rebuilt on every call. The two co-exist with no documented contract — inside `--stdin-loop` (long-lived process, #213), the same SSML quirk re-warns on every request.

5. **One source of truth per env var.** `KESHA_DEBUG` is parsed in two places (`src/log.ts` and `rust/src/debug.rs`) with subtly different rules. TS rejects `"0"` and case-insensitive `"false"` — `"False"` lower-cases to `"false"`, debug goes OFF. Rust rejects `"0"`, **exact-case** `"false"`, and `""` — `"False"` does NOT match the pattern, falls into the `Ok(_) => true` arm, debug goes ON. `KESHA_DEBUG=False kesha audio.ogg` flips the TS side OFF and the engine side ON.

## Findings

### P0 — user is blind right now

- [ ] **D1. Kokoro empty-audio bail without diagnostics** (`rust/src/tts/say.rs`)
  Tags: `[failures observable] [no-magic] [tts/kokoro]`.
  `say_with_kokoro` bails with `"no recognizable phonemes in input"` when `sess.infer_ipa(...)` returns an empty `Vec`. None of the inputs that produced the empty result are logged: IPA (length + first 20 chars), voice path, sample count.
  **Action:** `dtrace!("kokoro::infer.start ipa_len={n} voice={path}")` before the call and `dtrace!("kokoro::infer.end samples={s} dt={dt}ms")` after. On the empty branch: `dtrace!("kokoro::infer.empty ipa_first_20={…}")` before the bail.

- [ ] **D2. `ssml::parse` dedup is per-call, not per-process** (`rust/src/tts/ssml/mod.rs`, `walker.rs`)
  Tags: `[dedup-asymmetry] [ssml]`.
  Each `parse()` invocation builds a fresh `HashSet<String>` for `warned`. In `--stdin-loop` (#213, long-lived process), a 50-message session with the same `<prosody>` quirk floods stderr with 50 identical warnings. Inconsistent with `tts::warn::warn_once`, which dedups process-wide via `Mutex<HashSet<&'static str>>`.
  **Action:** route `ssml::parse` and `walker.rs` through `warn_once`, keyed by the `WARN_*` constants already in `tts/ssml/warnings.rs` (post-F1). Add new keys for the currently-stringly-keyed cases (`phoneme[alphabet={alpha}]`, `say-as[interpret-as={val}]`, `unknown-tag-{name}`). One source of truth.

- [ ] **D3. Capability gate silently drops user flags** (`src/synth.ts`)
  Tags: `[never swallow errors] [ts/cli]`.
  `buildSayArgs` logs the `--no-expand-abbrev` drop via `log.debug` only — invisible without `--debug` / `KESHA_DEBUG`. The user explicitly passed the flag; silently ignoring it violates the CLAUDE.md "NEVER SWALLOW ERRORS" rule.
  **Action:** swap `log.debug` for `log.warn` (yellow, always visible) with a clear message: `"--no-expand-abbrev requires engine ≥ 1.10.0 (advertises no tts.*_acronym_expansion capability); flag ignored"`.

### P1 — improves life

- [ ] **D4. Engine subprocess stderr passthrough is unclear** (`src/engine.ts`, `src/synth.ts`)
  Tags: `[failures observable] [ts/engine]`.
  Both call sites spawn `kesha-engine` with `stderr: "pipe"`. Need to confirm whether the piped stderr is forwarded to the user's stderr on the success path, or only surfaced inside `SayError.stderr` on non-zero exit. If only on error, warnings like `hint: audio is 180s; install --vad would improve` or `Model mirror active: …` get swallowed on green runs.
  **Action:** read `src/engine.ts::runEngine` and the spawn paths in `synth.ts` / `transcribe.ts`. Confirm-or-fix passthrough. The right model: spawn with `stderr: "inherit"` so engine warnings land live; capture only when the TS side needs to embed the message in a thrown error.

- [ ] **D5. Hash-mismatch error doesn't show the values** (`rust/src/models.rs`)
  Tags: `[failures observable] [models]`.
  `download_verified` bails with `"sha256 mismatch for {rel_path}"`. Neither expected nor got is in the message. User can't tell whether `KESHA_MODEL_MIRROR` served stale data, the download was corrupted, or upstream rehosted.
  **Action:** `anyhow::bail!("sha256 mismatch for {rel_path}: expected {expected_short} got {actual_short}")` — first 12 hex chars of each is enough to discriminate.

- [ ] **D6. G2P routing isn't traced** (`rust/src/tts/g2p.rs`)
  Tags: `[failures observable] [tts/g2p]`.
  `text_to_ipa(text, lang)` dispatches to misaki (English) / vosk-internal (Russian, in `tts/vosk.rs` instead) / nothing (unsupported language). When IPA comes out empty and the pipeline bails with `"empty after G2P"`, the user has no signal for which backend was picked or why it produced nothing.
  **Action:** add `dtrace!("g2p::route lang={lang} backend={selected} text_chars={n}")` at the top and `dtrace!("g2p::result ipa_chars={n}")` at the bottom of `text_to_ipa`.

- [ ] **D7. VAD all-silence fallback has no probability stats** (`rust/src/transcribe/mod.rs`)
  Tags: `[failures observable] [transcribe/vad]`.
  When VAD produces zero speech frames, transcribe falls back to a single full-file pass with a stderr warning. The actual frame stats (e.g. "0 of 120 frames passed the 0.5 threshold") are lost — the user can't tell whether the audio is actually silent or whether the threshold is too aggressive.
  **Action:** before the all-silence decision, `dtrace!("vad::result frames={total} speech_frames={s} ratio={r:.2} threshold={t}")`.

- [ ] **D8. AVSpeech sidecar stderr is lost** (`rust/src/tts/avspeech.rs`)
  Tags: `[failures observable] [tts/avspeech]`.
  `synthesize` returns `TtsError::SynthesisFailed("avspeech: {e}")` where `{e}` is Rust's interpretation of the subprocess result. If the Swift sidecar crashed mid-utterance, OOM'd, or couldn't resolve the voice identifier, its own stderr never reaches the user.
  **Action:** spawn the sidecar via `Command::output()` (captures stderr) instead of the current stderr-less form. On non-zero exit, fold the sidecar's stderr into the `TtsError::SynthesisFailed` payload.

### P2 — nice-to-have

- [ ] **D9. `KESHA_DEBUG` parse rules drift between TS and Rust** (`src/log.ts`, `rust/src/debug.rs`)
  Tags: `[one source of truth] [env-var]`.
  TS: `!!v && v !== "0" && v.toLowerCase() !== "false"` — case-insensitive `"false"` rejected, so `"False"` lower-cases to `"false"` and turns debug OFF. Rust: `match … { Ok("0" | "false" | "") | Err(_) => false, Ok(_) => true }` — only exact-case `"false"` matches the reject pattern, so `"False"` falls into `Ok(_) => true` and turns debug ON. `KESHA_DEBUG=False` therefore turns the TS-side debug OFF and the engine-side debug ON — silently inconsistent.
  **Action:** align both sides on the same grammar: case-insensitive reject of `{"", "0", "false", "no", "off"}`. Document the grammar in both files so the next contributor can't drift them apart again.

- [ ] **D10. `resolve_output_format` silent coercions** (`rust/src/main.rs`)
  Tags: `[no-magic] [cli/format]`.
  `--format opus` → `ogg-opus`, `.ogg` extension → `OggOpus`, fallthrough → `Wav`. If the user gets WAV when they expected opus, nothing explains which dispatcher arm fired.
  **Action:** `dtrace!("format::resolved chosen={fmt:?} source={src}")` where `src ∈ {"--format", "out-ext", "default"}`.

- [ ] **D11. Install: failed download doesn't show the URL** (`rust/src/models.rs`)
  Tags: `[failures observable] [models]`.
  `download_verified` calls `apply_mirror(f.url)` then `ureq::get(&url)`. On a network failure the ureq error message doesn't include the URL — particularly important when `KESHA_MODEL_MIRROR` is set, since the user can't tell whether the mirror rewrite was applied.
  **Action:** `.with_context(|| format!("GET {url}"))` on the `ureq::get(&url).call()` chain. Anyhow's context chain surfaces the URL in the final error.

## Notes

- 3 P0 + 5 P1 + 3 P2 = 11 findings.
- Audit-only: no implementation in this PR. Each finding becomes a checkbox on the tracking issue (companion to #267); each fix lands as its own PR referencing this audit's issue.
- Out of scope: a single global logging crate (`tracing` / `log` + `env_logger`). The current `dtrace!` macro fits the project's "boundary-only, off by default" discipline; pulling in `tracing` would be the right move at 3x the current volume but is overkill today.
