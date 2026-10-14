## Why

Mandarin synthesis on darwin-arm64 runs without jieba HMM segmentation. `kesha install --tts zh` stages the pinyin dictionaries but not the three HMM tables `ensureMandarinJiebaHmm` reads. At synthesis time offline mode turns the fetch into an `unsupported URL` failure, as it should, so FluidAudio falls back to FMM (dictionary-only segmentation) and logs on every run:

```
[WARN] [FluidAudio.KokoroAneResourceDownloader] Jieba HMM asset 'jieba_hmm_start.bin' unavailable (unsupported URL); HMM segmentation disabled.
```

#1433 confirmed the fallback live. Upstream publishes the tables at the revision kesha already pins (`FluidInference/kokoro-82m-coreml@1804dbc`, `ANE-zh/assets/`, about 290 KB together). A spike staged them by hand into `ANE-zh/g2p/`: the warning went away and synthesis exited 0.

## What Changes

- `kesha install --tts zh` downloads the three tables through `download_verified` with pinned SHA-256 hashes and stages them into `ANE-zh/g2p/`, where FluidAudio reads them.
- `model-plan.json` lists them, so `kesha install --plan` counts their bytes.
- The pre-synthesis asset check still does not require them. A user who installed zh before this change keeps synthesizing, on FMM, until the next `kesha install --tts zh`.

## Non-goals

- Making the tables required, which would fail existing zh installs until they re-run install.
- Any change to the English variant or to the other Mandarin assets.

## Capabilities

### Modified Capabilities

- `installation`: the jieba HMM requirement is replaced: the tables move from "not staged" to "staged at install, optional at synthesis".

## Impact

- `rust/src/models/manifest.rs` (a separate `ANE_ZH_HMM_ASSETS` list), `rust/src/models/staging.rs`, `model-plan.json`.
- `src/install-plan.ts` only if the plan gains a key; the design keeps the tables under the existing `aneZhG2p` key.
- Closes #1453.
