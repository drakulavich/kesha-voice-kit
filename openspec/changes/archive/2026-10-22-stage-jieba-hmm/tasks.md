## 1. Manifest

- [x] 1.1 Add `ANE_ZH_HMM_ASSETS` to `rust/src/models/manifest.rs` with the three tables at `1804dbc0`, local `g2p/…`, remote `ANE-zh/assets/…`, and their SHA-256 from the Hugging Face LFS metadata (the spike re-hashed the downloads and got the same values)
- [x] 1.2 Add them to the pinned-and-contained test and the required-files test; extend `assert_plan_paths` for `aneZhG2p` to `ANE_ZH_G2P_ASSETS` plus `ANE_ZH_HMM_ASSETS`
- [x] 1.3 Replace the "not staged" comment on `ANE_ZH_G2P_ASSETS`

## 2. Staging and plan

- [x] 2.1 `stage_fluidaudio_kokoro_assets` stages `ANE_ZH_HMM_ASSETS` into the zh bundle dir; `missing_kokoro_assets_in` keeps checking `ANE_ZH_G2P_ASSETS` only. Amend the comment on `missing_kokoro_assets` ("the required set is derived from the staging manifests") to name `ANE_ZH_HMM_ASSETS` as the one staged list it skips on purpose
- [x] 2.2 Add the three entries to `aneZhG2p` in `model-plan.json`
- [x] 2.4 `.github/scripts/check-model-plan-sizes.ts` maps `aneZhG2p` to both consts, since the plan group now spans two (found by `bun run check:fast`)
- [x] 2.3 A unit test: with every required zh file present and the HMM tables absent, `missing_kokoro_assets_in` returns nothing. Check it fails when the HMM list is checked too (a temporary edit, reverted)

## 3. Land

- [x] 3.1 Update the `installation` spec's Technical Note and the tts-internals skill if it mentions FMM (the delta carries the new note into the spec at archive; the skill does not mention FMM)
- [x] 3.2 Run `kesha install --tts zh` with a source-built engine, then `kesha say` in Mandarin, and record the stderr in the PR

## Definition of Done

- [x] `grep -c jieba_hmm model-plan.json` prints 3
- [x] `grep -c ANE_ZH_HMM_ASSETS rust/src/models/staging.rs` prints at least 2: the staging call and the not-required test
- [x] `cd rust && cargo nextest run --no-default-features --features darwin -E "test(models::)"` passes, including the plan-paths, pinned-and-contained and required-files tests with the three tables, and a test that `missing_kokoro_assets_in` reports nothing when only the HMM tables are absent
- [x] With a source-built engine, `kesha install --tts zh` leaves `jieba_hmm_{start,trans,emit}.bin` in `ANE-zh/g2p/` under the directory `fluidaudio_kokoro_location` resolves: the legacy `~/.cache/fluidaudio/Models/kokoro-82m-coreml` when it already has entries (as on the maintainer machine), else `<kesha cache>/fluidaudio/kokoro-82m-coreml`, and `KESHA_DEBUG=1 kesha say --voice zh-zm_050 "你好世界"` exits 0 with no `HMM segmentation disabled` on stderr
- [x] `openspec validate stage-jieba-hmm --strict` and `bun run check:fast` pass
