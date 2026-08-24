# Mutation evidence — #1093 (Kokoro ANE manifest pinned to a mutable ref)

Two guards assert the same rule — no `huggingface.co` manifest URL may resolve through a
mutable ref such as `main`, only a 40-hex commit — from two different angles, because they
run in different lanes:

| Guard | Where it runs | What it sees |
|---|---|---|
| `rust/src/models.rs::manifest_tests::every_huggingface_url_pins_an_immutable_revision` | `🧪 Rust Tests` (every PR, default `--features tts` build) | 6 of 7 pinned repos — every manifest **except** the `system_kokoro`-gated ANE ones. Those five macros (`ane_en_file!`, `kokoro_g2p_file!`, `ane_zh_file!`, `ane_zh_asset!`, `ane_kokoro_voice!`) only compile under `--features system_kokoro,target_os=macos,target_arch=aarch64`, and no CI job runs `cargo test`/`nextest` with that combination — the per-PR macos-14 leg only `cargo clippy`s it (`just verify-darwin-full`), which type-checks but never executes `#[test]` bodies. This is the gap Greptile's #1096 review flagged: the guard for the ANE manifests — where the #1093 regression actually lived — was real but CI-invisible. |
| `tests/unit/check-model-plan-sizes.test.ts > parseManifestUrls > no huggingface.co url in the real manifest resolves through a mutable ref` | `🧪 CI` (every PR, plain `bun test`, no feature gating at all) | **All 7 repos, including the ANE manifests.** Reads `rust/src/models.rs` as text via `parseManifestEntries` (a new export, alongside the existing `parseManifestUrls`), which expands the `ModelFile`-building macros and lists every entry — it isn't compiling Rust, so `#[cfg(...)]` is invisible to it. This is the guard that closes the CI-reach gap: it runs on every PR and would have caught #1093 without needing a macOS `system_kokoro` test lane. |

Keeping both: the Rust guard is the typed one and stays useful wherever it does run
(local `system_kokoro` builds, `just mutate` locally); the TS guard buys reach without
adding a new CI lane.

## Why `parseManifestEntries`, not the existing `parseManifestUrls`

`parseManifestUrls` returns a `Map<relPath, url>`. The English (`ANE/`) and Mandarin
(`ANE-zh/`) ANE bundles stage identical basenames — e.g.
`KokoroAlbert.mlmodelc/analytics/coremldata.bin` — into different directories at install
time (`stage_into(&fluidaudio_ane_kokoro_dir()?, ANE_EN_FILES, …)` vs
`stage_into(&zh, ANE_ZH_FILES, …)`), so `relPath` is not a unique key across the whole
manifest. Building the URL-pin guard on top of the deduping map would let `ANE_ZH_FILES`
(declared after `ANE_EN_FILES` in `models.rs`) silently shadow the English entry for every
colliding key — a guard that looked like it covered "all 7 repos" while actually skipping
half of one of them. `parseManifestEntries` returns every `{relPath, url}` pair in source
order instead, with no deduping; `parseManifestUrls` is now defined in terms of it
(behaviour-preserving for existing callers — same "last declaration wins" map).
`keeps colliding rel_paths as separate entries rather than letting one shadow the other`
in `check-model-plan-sizes.test.ts` pins this directly.

## Rust guard — mutation proof

Command (matches `just mutate`'s default `FEATURES`, since the ANE manifests only compile
under it):

```
just mutate rust/src/models.rs \
  'FluidInference/kokoro-82m-coreml/resolve/c94edcb4b671856795458645cd389c0a9184e8bb/' \
  'FluidInference/kokoro-82m-coreml/resolve/main/' \
  cargo nextest run --manifest-path rust/Cargo.toml \
    --features tts,system_kokoro,system_diarize --no-default-features --features onnx \
    manifest_tests::every_huggingface_url_pins_an_immutable_revision
```

| Mutation | Occurrences | Guard result |
|---|---|---|
| Revert the `FluidInference/kokoro-82m-coreml` pin from the immutable commit `c94edcb4b6…` back to `main` | 5 | **PINNED** — fails: `pins mutable ref "main" instead of a 40-hex commit` |

Restore-to-green: `just mutate` restores the file in a `finally` regardless of outcome;
`cargo nextest run --features tts,system_kokoro,system_diarize --no-default-features --features onnx manifest_tests::every_huggingface_url_pins_an_immutable_revision`
passes again on the restored file (1 passed, 0 failed).

The same guard also covers the other 6 pinned repos (`istupakov/parakeet-tdt-0.6b-v3-onnx`,
`FluidInference/diar-streaming-sortformer-coreml`, `drakulavich/SpeechBrain-coreml`,
`onnx-community/Kokoro-82M-v1.0-ONNX`, `klebster/g2p_multilingual_byT5_tiny_onnx`,
`drakulavich/vosk-tts-ru-0.9-multi`) under the default `--features tts` build, which is the
build `🧪 Rust Tests` actually runs.

## TS guard — mutation proof

Both commands run exactly as `🧪 CI` would — no feature flags, no macOS requirement.

**All four ANE macros reverted at once** (the literal shared verbatim across
`ane_en_file!`, `kokoro_g2p_file!`, `ane_zh_file!`, `ane_zh_asset!`, plus the
`staged_manifests_are_pinned_and_contained` Rust test assertion — 5 occurrences):

```
just mutate rust/src/models.rs \
  'FluidInference/kokoro-82m-coreml/resolve/c94edcb4b671856795458645cd389c0a9184e8bb/' \
  'FluidInference/kokoro-82m-coreml/resolve/main/' \
  bun test tests/unit/check-model-plan-sizes.test.ts -t "mutable ref"
```

| Mutation | Occurrences | Guard result |
|---|---|---|
| Revert all four ANE macros' pin to `main` | 5 | **PINNED** — fails, naming all 94 affected manifest entries (37 `ANE/` + 12 shared G2P + 43 `ANE-zh/` + 2 pinyin assets) |

**English-only regression** — reverts *only* `ane_en_file!`'s pin, leaving `ane_zh_file!`
correctly pinned. This is the mutation that specifically exercises the `relPath` collision
fix: against the old `parseManifestUrls`-backed test, the later-declared, still-correctly-pinned
`ANE_ZH_FILES` entry would have shadowed every colliding `ANE_EN_FILES` key in the map and
the guard would have missed this regression entirely.

```
just mutate rust/src/models.rs \
  $'"https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/c94edcb4b671856795458645cd389c0a9184e8bb/",\n                "ANE/",' \
  $'"https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/main/",\n                "ANE/",' \
  bun test tests/unit/check-model-plan-sizes.test.ts -t "mutable ref"
```

| Mutation | Occurrences | Guard result |
|---|---|---|
| Revert only `ane_en_file!`'s pin to `main` (`ANE_ZH_FILES` stays correctly pinned) | 1 | **PINNED** — fails, naming all 37 `ANE_EN_FILES` entries; `ANE_ZH_FILES`'s 43 entries correctly report their still-pinned commit |

Restore-to-green after each: `just mutate` restores the file in a `finally`; `bun test
tests/unit/check-model-plan-sizes.test.ts -t "mutable ref"` passes again on the restored
file (1 passed, 0 failed).
