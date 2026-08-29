# Mutation evidence — #1093 (Kokoro ANE manifest pinned to a mutable ref)

Two guards assert the same rule — no **Hugging Face manifest URL** may resolve through a
mutable ref, only a 40-hex commit — from two different angles, because they run in
different lanes, and each has known reach:

| Guard | File | Test | Where it runs | Reach |
|---|---|---|---|---|
| Rust | `rust/src/models.rs` | `manifest_tests::every_huggingface_url_pins_an_immutable_revision` | `🧪 Rust Tests` (every PR, default `--features tts` build) | 6 of 7 pinned repos — every manifest **except** the `system_kokoro`-gated ANE ones. Those five macros (`ane_en_file!`, `kokoro_g2p_file!`, `ane_zh_file!`, `ane_zh_asset!`, `ane_kokoro_voice!`) only compile under `--features system_kokoro,target_os=macos,target_arch=aarch64`, and no CI job runs `cargo test`/`nextest` with that combination — the per-PR macos-14 leg only `cargo clippy`s it (`just verify-darwin-full`), which type-checks but never executes `#[test]` bodies. |
| TS | `tests/unit/check-model-plan-sizes.test.ts` | `parseManifestUrls > no Hugging Face manifest URL resolves through a mutable ref` | `🧪 CI` (every PR, plain `bun test`, no feature gating at all) | **All 7 repos, including the ANE manifests.** Reads `rust/src/models.rs` as text via `parseManifestEntries` (new export in `.github/scripts/check-model-plan-sizes.ts`), which expands the `ModelFile`-building macros and lists every entry — it isn't compiling Rust, so `#[cfg(...)]` is invisible to it. This is the guard that closes the CI-reach gap Greptile's #1096 review round 1 flagged: it runs on every PR and would have caught #1093 without a macOS `system_kokoro` test lane. |

**Reach note on a third, older assertion:** `staged_manifests_are_pinned_and_contained` at
`rust/src/models.rs:2731` also asserts a URL prefix against the Kokoro ANE manifests, but
it has the exact same `system_kokoro`-gated compile requirement as the guard above and
**no CI lane executes it either** — its reach is `none`. It stays in the suite (useful on
a local `system_kokoro` build) but the TS guard above, not this one, is what actually
protects `🧪 CI`; do not read the Rust assertion at that line as a live gate.

## Scope: Hugging Face manifest URLs only

Both guards check `startsWith("https://huggingface.co/")` / `strip_prefix("https://huggingface.co/")`
and skip anything else. Two manifest URLs are GitHub-hosted and neither is immutable
either, but on purpose neither is in scope here:

- `rust/src/models.rs:70` — `snakers4/silero-vad/raw/v6.2.1/…` resolves through a **git
  tag**, which can be moved or recreated.
- `rust/src/models.rs:203` — `thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/…`
  is a **GitHub release asset**, which can be deleted and re-uploaded under the same tag.

Either would fail exactly the way #1093 failed: the SHA-256 pin turns the upstream move
into a hard `E_CACHE_CORRUPT` at install rather than a silent swap, which is the pin
working as designed — and is also precisely the outage class this ticket is about, so it
is tempting to fold them in. Deliberately out of scope: the silero-vad tag *could* be
repinned to a commit SHA (a GitHub tag resolves to one, same as a Hugging Face revision) —
tracked as #1099. The kokoro-onnx release asset has no immutable URL form at all (GitHub
release assets are addressed by tag, not commit), so for that one file the SHA-256 pin is
the only guard there will ever be; widening the "must be a 40-hex ref" rule to it would be
asserting something that can never hold.

**Update (#1099):** the silero-vad line above is now pinned to a commit; see
`docs/mutation-evidence/issue-1099.md` for the guard and its mutation proof. The kokoro-onnx
release asset remains permanently unpinnable and carries a one-line note at its declaration
instead.

## Why `parseManifestEntries`, not the existing `parseManifestUrls`

`parseManifestUrls` returns a `Map<relPath, url>`. The English (`ANE/`) and Mandarin
(`ANE-zh/`) ANE bundles stage identical basenames — e.g.
`KokoroAlbert.mlmodelc/analytics/coremldata.bin` — into different directories at install
time (`stage_into(&fluidaudio_ane_kokoro_dir()?, ANE_EN_FILES, …)` vs
`stage_into(&zh, ANE_ZH_FILES, …)`), so `relPath` is not a unique key across the whole
manifest. Building the URL-pin guard on top of the deduping map would let `ANE_ZH_FILES`
(declared after `ANE_EN_FILES` in `models.rs`) silently shadow the English entry for every
colliding key. `parseManifestEntries` returns every `{relPath, url}` pair in source order
instead, with no deduping; `parseManifestUrls` is now defined in terms of it (same
last-wins semantics, no behaviour change for existing callers).
`keeps colliding rel_paths as separate entries rather than letting one shadow the other`
in `check-model-plan-sizes.test.ts` pins this directly.

## Why the ref check is positive, not a denylist

The TS guard's first version matched `/resolve\/([^/]+)\//` and skipped (`continue`) when
that failed to match. `[^/]+` requires at least one character, so a botched edit producing
`resolve//` — a URL that 404s at install time, a *worse* failure than drifting to `main` —
left an empty ref segment the regex could not capture, and the `undefined` case fell
through unseen (#1096 review round 2). The fixed version (`tests/unit/check-model-plan-sizes.test.ts:142-151`)
asserts positively instead: split on `/resolve/`, take the first path segment after it
(`""` if there is none), and require it to match `^[0-9a-f]{40}$` — nothing short-circuits
to "skip". The Rust guard (`assert_pins_immutable_revision`,
`rust/src/models.rs:2217-2230`) was checked for the same shape and was already safe: it
`panic!`s outright when `/resolve/` is missing, and an empty captured segment already
fails the `len() == 40` check — proven below rather than assumed.

## Mutation proof

Every row: `just mutate <file> <find> <replace> <test command>`, restored in a `finally`
regardless of outcome; every restore was confirmed with a clean `git status --short`
afterward and a green re-run of the named test. Every Rust row names the exact
`cargo nextest` feature flags it ran under, because the guard's reach depends on them:
rows 2–4 target `VOSK_RU_FILES`, which compiles under the plain `--features tts`
`🧪 Rust Tests` actually runs, so `PINNED` there is a real CI result. Row 1 targets the
`system_kokoro`-gated ANE manifest, which does not compile under that flag at all — its
`PINNED` result is real too, but only for the wider local build the row names, matching
the `none` reach already recorded in the table above; do not read it as CI coverage.

| # | Guard | File | Test | Mutation | Occurrences | Result |
|---|---|---|---|---|---|---|
| 1 | Rust | `rust/src/models.rs` | `manifest_tests::every_huggingface_url_pins_an_immutable_revision` | Revert `FluidInference/kokoro-82m-coreml`'s pin to `main` (all four ANE macros, since they share the literal), run via `cargo nextest run --features tts,system_kokoro,system_diarize --no-default-features --features onnx …` — **not** the `--features tts` build `🧪 Rust Tests` runs; required because the ANE macros don't compile without `system_kokoro` | 5 | **PINNED, lane `none`** — `pins mutable ref "main" instead of a 40-hex commit`, on a build no CI job runs as tests |
| 2 | Rust | `rust/src/models.rs` | `manifest_tests::every_huggingface_url_pins_an_immutable_revision` | Revert `drakulavich/vosk-tts-ru-0.9-multi`'s pin to `resolve//` (empty ref / deleted revision), run via `cargo nextest run --features tts …` — the same default build `🧪 Rust Tests` runs | 1 | **PINNED** — `pins mutable ref "" instead of a 40-hex commit` |
| 3 | Rust | `rust/src/models.rs` | `manifest_tests::every_huggingface_url_pins_an_immutable_revision` | Revert `drakulavich/vosk-tts-ru-0.9-multi`'s pin to a non-`main`, non-hex ref (`v1.0-legacy`), run via `cargo nextest run --features tts …` — same default build | 1 | **PINNED** — `pins mutable ref "v1.0-legacy" instead of a 40-hex commit` |
| 4 | Rust | `rust/src/models.rs` | `manifest_tests::every_huggingface_url_pins_an_immutable_revision` | Delete the `/resolve/<ref>/` segment entirely from `drakulavich/vosk-tts-ru-0.9-multi`'s URL, run via `cargo nextest run --features tts …` — same default build | 1 | **PINNED** — `huggingface.co url has no /resolve/<ref>/ segment` |
| 5 | TS | `tests/unit/check-model-plan-sizes.test.ts` | `parseManifestUrls > no Hugging Face manifest URL resolves through a mutable ref` | Revert `FluidInference/kokoro-82m-coreml`'s pin to `main` (all four ANE macros) | 5 | **PINNED** — fails, naming all 94 affected manifest entries (37 `ANE/` + 12 shared G2P + 43 `ANE-zh/` + 2 pinyin assets) |
| 6 | TS | `tests/unit/check-model-plan-sizes.test.ts` | `parseManifestUrls > no Hugging Face manifest URL resolves through a mutable ref` | Revert **only** `ane_en_file!`'s pin to `main`, leaving `ane_zh_file!` correctly pinned (the `relPath`-collision case) | 1 | **PINNED** — fails, naming all 37 `ANE_EN_FILES` entries; `ANE_ZH_FILES`'s 43 entries correctly report their still-pinned commit |
| 7 | TS | `tests/unit/check-model-plan-sizes.test.ts` | `parseManifestUrls > no Hugging Face manifest URL resolves through a mutable ref` | Revert `drakulavich/vosk-tts-ru-0.9-multi`'s pin to `resolve//` (empty ref / deleted revision — the exact hole review round 2 found) | 1 | **PINNED** — fails, naming all 5 `VOSK_RU_FILES` entries; before the ref-parsing fix this mutation **survived** (`NOT PINNED`) |
| 8 | TS | `tests/unit/check-model-plan-sizes.test.ts` | `parseManifestUrls > no Hugging Face manifest URL resolves through a mutable ref` | Revert `drakulavich/vosk-tts-ru-0.9-multi`'s pin to a non-`main`, non-hex ref (`v1.0-legacy`) | 1 | **PINNED** — fails, naming all 5 `VOSK_RU_FILES` entries |
| 9 | TS | `tests/unit/check-model-plan-sizes.test.ts` | `parseManifestUrls > no Hugging Face manifest URL resolves through a mutable ref` | Delete the `/resolve/<ref>/` segment entirely from `drakulavich/vosk-tts-ru-0.9-multi`'s URL | 1 | **PINNED** — fails, naming all 5 `VOSK_RU_FILES` entries |

Rows 1 and 5 are the ticket's actual regression, reproduced exactly — but only row 5 is a
CI result; row 1 needed the wider, non-CI `system_kokoro` build to compile at all (review
round 4), which is the whole reason this PR needed the TS guard in the first place. Rows
2–4 and 7–9 prove both guards generalise past a `main`-only denylist: an empty ref, a
plausible-looking but non-hex ref, and a URL with no `/resolve/` segment at all are all
caught, not just the literal string `main`. Row 6 proves the `relPath`-collision fix does
something — against the pre-fix, map-based approach this regression would have been
invisible. Row 7 is the one review round 2 asked for by name; the pre-fix guard's
`NOT PINNED` result for it was reproduced and is the reason rows 5–9 exist in their
current (post-fix) form.

**Known drift risk in this table:** the "Test" column repeats each guard's exact function
or `test(...)` name in prose, and nothing re-checks that string against the source if
either test is renamed later — a rename would go stale here silently. No automated,
in-scope way to make that loud was found this round (adding one would be a new test, which
this round explicitly does not owe); flagging it here rather than adding tooling.
