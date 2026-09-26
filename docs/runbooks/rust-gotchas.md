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

`Value::from_array(arr)` consumes its input; views (`ArrayView2`, `.view()`) don't implement `OwnedTensorArrayData`. `Array2::ones((1, n))` inline at the call site is the cleanest fresh owned construction. `Array2::from_shape_vec((...), buf.clone())` also works at the cost of a clone. `Session::builder()` returns `ort::Result` that converts through `anyhow::Context::context("...")?` cleanly — **no `map_err(anyhow::Error::msg)` dance needed**, despite what the #123 spike doc originally claimed. Peer modules (`lang_id.rs`, `vad.rs`, `backend/onnx.rs`, `tts/kokoro.rs`) all use `.context()?`; match that style.

## CLIPPY `needless_update` BLOCKS `..Default::default()` IF ALL FIELDS ARE SPELLED

Tempting "forward-compat" pattern: `MyStruct { a: 1, b: 2, ..Default::default() }` so a future new field doesn't break the call site. Clippy fires `needless_update` when all current fields are already spelled (the `..` is no-op today), and `-D warnings` promotes it to deny. CI red.

The forward-compat is already there for free: Rust requires exhaustive struct init for any struct NOT marked `#[non_exhaustive]`. Adding a new field makes the call site a compile error pointing at the literal, which is exactly the breakage that needs to be surfaced.

- Spell all fields explicitly.
- Skip `..Default::default()` — the compile error on field addition is the safety.
- If callers across crate boundaries need forward-compat (e.g. a published lib), mark the struct `#[non_exhaustive]` instead.
- Past incident: #290 P2 (F5 follow-up) suggested adding `..Default::default()`, clippy blocked it, the comment explaining the trade-off landed instead.

## BINDGEN ON MACOS NEEDS LIBCLANG_PATH

The only `bindgen` user in the tree is `coreaudio-sys`, a build dependency of `cpal` on macOS (`cargo tree -i bindgen --target all`); Linux and Windows builds never run it. Its build script `dlopen`s libclang, so a macOS build outside Xcode's default search path needs `LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib` — the value `ci.yml` sets on its source-build step.

## SILERO VAD V5 NEEDS A 64-SAMPLE ROLLING CONTEXT

Silero VAD v5 at 16 kHz wants ONNX `input` of length **576**, not 512: 64 samples of tail from the previous frame + 512 new samples. Missing this produces per-frame probabilities of ~0.0005 regardless of content — the model "runs" without detecting speech. Not in the ONNX metadata; only in upstream's Python `OnnxWrapper`. See `rust/src/vad.rs::frame_probs` for the rolling-context mechanics.

## TESTS THAT STAGE A TEMPDIR CACHE FOR ES/FR/IT/PT MUST STAGE G2P TOO

On ONNX builds, Spanish, French, Italian and Portuguese Kokoro phonemize through CharsiuG2P at `$KESHA_CACHE_DIR/models/g2p/byt5-tiny/`. A test that creates a fresh `KESHA_CACHE_DIR` tempdir for one of those languages and stages only Kokoro fails with `G2P model not installed` (`tts::g2p::check_charsiu_files`). English (embedded misaki-rs, #211) and Russian (Vosk) need no G2P artifact — see `rust/tests/tts_smoke.rs::resolves_from_cache_when_installed`.

## VERIFICATION TOOLING — `cargo nextest`, CLIPPY, RUSTFMT

Moved out of CLAUDE.md (2026-07-26) with the rest of the Rust detail.

- Always `cargo nextest run`, never plain `cargo test`. CI uses nextest (`ci` profile, JUnit → Flakiness.io); it isolates tests in fresh processes, runs integration binaries in parallel, and streams `SLOW [>60.000s]` markers for Vosk/Kokoro. Install once: `cargo install cargo-nextest --locked`. The only sanctioned plain `cargo test` calls are `--doc` and the pin-bump's `cargo test models::manifest`.
- Keep `--all-targets` on clippy. Without it, local clippy misses `#[cfg(test)]` dead code that ubuntu CI catches (#125 M1).
- The root `rust-toolchain.toml` pins CI and local Rust. Confirm the active compiler with `rustup show`; if CI-only clippy fails, read `gh run view <id> --log-failed` before changing code.
- CI `rustfmt --check` wins over local formatting. If it rejects line wrapping, re-run `cargo fmt` and push the whitespace-only diff (#309).
