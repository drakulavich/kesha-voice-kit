# Mutation evidence — #1093 (Kokoro ANE manifest pinned to a mutable ref)

Two guards assert the same rule — no `huggingface.co` manifest URL may resolve through a
mutable ref, only a 40-hex commit — from two different angles, because they run in
different lanes, and each has known reach:

| Guard | File | Where it runs | Reach |
|---|---|---|---|
| `every_huggingface_url_pins_an_immutable_revision` | `rust/src/models.rs` (`manifest_tests` mod) | `🧪 Rust Tests` (every PR, default `--features tts` build) | 6 of 7 pinned repos — every manifest **except** the `system_kokoro`-gated ANE ones. Those five macros (`ane_en_file!`, `kokoro_g2p_file!`, `ane_zh_file!`, `ane_zh_asset!`, `ane_kokoro_voice!`) only compile under `--features system_kokoro,target_os=macos,target_arch=aarch64`, and no CI job runs `cargo test`/`nextest` with that combination — the per-PR macos-14 leg only `cargo clippy`s it (`just verify-darwin-full`), which type-checks but never executes `#[test]` bodies. |
| `no huggingface.co url in the real manifest resolves through a mutable ref` | `tests/unit/check-model-plan-sizes.test.ts` (`parseManifestUrls` describe) | `🧪 CI` (every PR, plain `bun test`, no feature gating at all) | **All 7 repos, including the ANE manifests.** Reads `rust/src/models.rs` as text via `parseManifestEntries` (new export in `.github/scripts/check-model-plan-sizes.ts`), which expands the `ModelFile`-building macros and lists every entry — it isn't compiling Rust, so `#[cfg(...)]` is invisible to it. This is the guard that closes the CI-reach gap Greptile's #1096 review round 1 flagged: it runs on every PR and would have caught #1093 without a macOS `system_kokoro` test lane. |

**Reach note on a third, older assertion:** `staged_manifests_are_pinned_and_contained` at
`rust/src/models.rs:2731` also asserts a URL prefix against the Kokoro ANE manifests, but
it has the exact same `system_kokoro`-gated compile requirement as the guard above and
**no CI lane executes it either** — its reach is `none`. It stays in the suite (useful on
a local `system_kokoro` build) but the TS guard above, not this one, is what actually
protects `🧪 CI`; do not read the Rust assertion at that line as a live gate.

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
afterward and a green re-run of the named test.

| # | Guard (file, test) | Mutation | File mutated | Occurrences | Result |
|---|---|---|---|---|---|
| 1 | Rust — `rust/src/models.rs`, `manifest_tests::every_huggingface_url_pins_an_immutable_revision` | Revert `FluidInference/kokoro-82m-coreml`'s pin to `main` (all four ANE macros, since they share the literal) | `rust/src/models.rs` | 5 | **PINNED** — `pins mutable ref "main" instead of a 40-hex commit` |
| 2 | Rust — same | Revert `drakulavich/vosk-tts-ru-0.9-multi`'s pin to `resolve//` (empty ref / deleted revision) | `rust/src/models.rs` | 1 | **PINNED** — `pins mutable ref "" instead of a 40-hex commit` |
| 3 | Rust — same | Revert `drakulavich/vosk-tts-ru-0.9-multi`'s pin to a non-`main`, non-hex ref (`v1.0-legacy`) | `rust/src/models.rs` | 1 | **PINNED** — `pins mutable ref "v1.0-legacy" instead of a 40-hex commit` |
| 4 | Rust — same | Delete the `/resolve/<ref>/` segment entirely from `drakulavich/vosk-tts-ru-0.9-multi`'s URL | `rust/src/models.rs` | 1 | **PINNED** — `huggingface.co url has no /resolve/<ref>/ segment` |
| 5 | TS — `tests/unit/check-model-plan-sizes.test.ts`, `parseManifestUrls > no huggingface.co url in the real manifest resolves through a mutable ref` | Revert `FluidInference/kokoro-82m-coreml`'s pin to `main` (all four ANE macros) | `rust/src/models.rs` | 5 | **PINNED** — fails, naming all 94 affected manifest entries (37 `ANE/` + 12 shared G2P + 43 `ANE-zh/` + 2 pinyin assets) |
| 6 | TS — same | Revert **only** `ane_en_file!`'s pin to `main`, leaving `ane_zh_file!` correctly pinned (the `relPath`-collision case) | `rust/src/models.rs` | 1 | **PINNED** — fails, naming all 37 `ANE_EN_FILES` entries; `ANE_ZH_FILES`'s 43 entries correctly report their still-pinned commit |
| 7 | TS — same | Revert `drakulavich/vosk-tts-ru-0.9-multi`'s pin to `resolve//` (empty ref / deleted revision — the exact hole review round 2 found) | `rust/src/models.rs` | 1 | **PINNED** — fails, naming all 5 `VOSK_RU_FILES` entries; before the ref-parsing fix this mutation **survived** (`NOT PINNED`) |
| 8 | TS — same | Revert `drakulavich/vosk-tts-ru-0.9-multi`'s pin to a non-`main`, non-hex ref (`v1.0-legacy`) | `rust/src/models.rs` | 1 | **PINNED** — fails, naming all 5 `VOSK_RU_FILES` entries |
| 9 | TS — same | Delete the `/resolve/<ref>/` segment entirely from `drakulavich/vosk-tts-ru-0.9-multi`'s URL | `rust/src/models.rs` | 1 | **PINNED** — fails, naming all 5 `VOSK_RU_FILES` entries |

Rows 1 and 5 are the ticket's actual regression, reproduced exactly. Rows 2–4 and 7–9
prove both guards generalise past a `main`-only denylist: an empty ref, a plausible-looking
but non-hex ref, and a URL with no `/resolve/` segment at all are all caught, not just the
literal string `main`. Row 6 proves the `relPath`-collision fix does something — against
the pre-fix, map-based approach this regression would have been invisible. Row 7 is the
one review round 2 asked for by name; the pre-fix guard's `NOT PINNED` result for it was
reproduced and is the reason rows 5–9 exist in their current (post-fix) form.
