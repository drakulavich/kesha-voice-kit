# Rust Gotchas Runbook

> Extracted from CLAUDE.md (chore/slim-claudemd, 2026-05-31) to keep the always-loaded
> instructions under Claude Code's 40k-char performance threshold. Read this when writing
> or debugging Rust in `rust/`.

## `f32::clamp` DIVERGENCE: USE BOUND CHECK, NOT `EPSILON`

When detecting whether `f32::clamp(raw, lo, hi)` actually changed the value (e.g. to fire a one-time warning), `(raw - clamped).abs() > f32::EPSILON` is the WRONG tolerance:

- `f32::EPSILON ≈ 1.19e-7` is the ULP at value `1.0`.
- ULP scales with the magnitude. At raw ≈ 0.5, ULP ≈ 5.96e-8 — **below `EPSILON`**.
- A value one ULP below `0.5` clamps to `0.5`, but `|raw - clamped|` ≈ 6e-8 doesn't exceed `EPSILON`. The warning silently misses the clamp.

Correct pattern: check the bounds directly.
```rust
if !(lo..=hi).contains(&raw) {
    // raw was outside the range; clamped to a bound
}
```

- Idiomatic (clippy prefers `RangeInclusive::contains` over `raw < lo || raw > hi`, lint `manual_range_contains`).
- **NaN flows through and fires the guard.** `NaN < x` and `x < NaN` are both false → `(lo..=hi).contains(&NaN) == false` → `!false == true` → guard DOES fire on NaN. `f32::clamp(NaN, lo, hi)` returns NaN unchanged (NaN-passthrough), so the warning text will say "rate NaN ... clamped to NaN" — typically intentional, because NaN at this layer means an upstream parse bug and surfacing it on stderr beats silently feeding NaN into the downstream model. If you DO want to suppress, check `raw.is_nan()` explicitly first and decide what to do. (Same NaN inversion that #289 corrected in `compose_rate` — re-introducing it here was caught by Greptile on #294.)
- Symmetric with the `clamp` itself.

Past incidents: #287 → #288 → #289 cascade for F9 (`compose_rate` rate-clamp warning). #287 shipped with `EPSILON`, Greptile P2 caught the ULP gap, #288 fixed via `!(0.5..=2.0).contains(&raw)`, #289 corrected an inverted NaN claim in the accompanying comment.

## `ort 2.0.0-rc.12` `Value::from_array` WANTS OWNED NDARRAYS

`Value::from_array(arr)` consumes its input; views (`ArrayView2`, `.view()`) don't implement `OwnedTensorArrayData`. `Array2::ones((1, n))` inline at the call site is the cleanest fresh owned construction. `Array2::from_shape_vec((...), buf.clone())` also works at the cost of a clone. `Session::builder()` returns `ort::Result` that converts through `anyhow::Context::context("...")?` cleanly — **no `map_err(anyhow::Error::msg)` dance needed**, despite what the #123 spike doc originally claimed. Peer modules (`lang_id.rs`, `vad.rs`, `backend/onnx.rs`, `kokoro.rs`, `piper.rs`) all use `.context()?`; match that style.

## CLIPPY `needless_update` BLOCKS `..Default::default()` IF ALL FIELDS ARE SPELLED

Tempting "forward-compat" pattern: `MyStruct { a: 1, b: 2, ..Default::default() }` so a future new field doesn't break the call site. Clippy fires `needless_update` when all current fields are already spelled (the `..` is no-op today), and `-D warnings` promotes it to deny. CI red.

The forward-compat is already there for free: Rust requires exhaustive struct init for any struct NOT marked `#[non_exhaustive]`. Adding a new field makes the call site a compile error pointing at the literal, which is exactly the breakage that needs to be surfaced.

- Spell all fields explicitly.
- Skip `..Default::default()` — the compile error on field addition is the safety.
- If callers across crate boundaries need forward-compat (e.g. a published lib), mark the struct `#[non_exhaustive]` instead.
- Past incident: #290 P2 (F5 follow-up) suggested adding `..Default::default()`, clippy blocked it, the comment explaining the trade-off landed instead.

## BINDGEN ON LINUX NEEDS LIBCLANG_PATH

Any Rust crate using `bindgen` (directly or transitively — e.g. `espeakng-sys` with `clang-runtime` feature) needs `LIBCLANG_PATH` on Linux build runners even with `apt install libclang-dev`. The `clang-runtime` feature makes bindgen `dlopen` libclang at build-script runtime; the apt package installs into a versioned subdir that isn't on the default dlopen path.

Portable recipe for the Linux job:
```yaml
- run: |
    sudo apt-get install -y libclang-dev llvm-dev
    echo "LIBCLANG_PATH=$(llvm-config --libdir)" >> $GITHUB_ENV
```

macOS equivalent is `LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib`. Windows uses `C:\Program Files\LLVM\bin` with LLVM installed via `choco install llvm` and MSVC tooling activated via `ilammy/msvc-dev-cmd@v1` in CI. espeak-ng on Windows needs an import lib synthesized from the choco-shipped DLL via `dumpbin /exports` + `lib /def:… /machine:x64 /out:espeak-ng.lib` — see the Windows block in `rust-test.yml`.

## SILERO VAD V5 NEEDS A 64-SAMPLE ROLLING CONTEXT

Silero VAD v5 at 16 kHz wants ONNX `input` of length **576**, not 512: 64 samples of tail from the previous frame + 512 new samples. Missing this produces per-frame probabilities of ~0.0005 regardless of content — the model "runs" without detecting speech. Not in the ONNX metadata; only in upstream's Python `OnnxWrapper`. See `rust/src/vad.rs::frame_probs` for the rolling-context mechanics.

## `fluidaudio-rs 0.1.0` LACKS `transcribe_samples`

The method exists on upstream `main` but isn't in the published 0.1.0 crate. The CoreML `TranscribeBackend::transcribe_samples` impl writes a temp IEEE_FLOAT WAV at 16 kHz mono f32 and calls `transcribe_file` — see `rust/src/backend/fluidaudio.rs`. Drop the shim when upstream cuts a new release that exposes `transcribe_samples` directly.

## TESTS THAT STAGE A TEMPDIR CACHE MUST STAGE G2P TOO

Post-#123 (v1.4.0), Kokoro + Piper synthesis flows through the ONNX G2P at `$KESHA_CACHE_DIR/models/g2p/byt5-tiny/`. Any test that creates a fresh `KESHA_CACHE_DIR` tempdir and copies in only Kokoro / Piper will fail with `SynthesisFailed("g2p: G2P model not installed")`. Use `models::is_g2p_cached(dir)` + `models::g2p_model_dir()` to gate + copy the ONNX files. Examples: `rust/tests/tts_smoke.rs::resolves_from_cache_when_installed`, `tests/integration/say-e2e.test.ts::beforeAll`.
