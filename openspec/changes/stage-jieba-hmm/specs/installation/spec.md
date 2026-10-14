## REMOVED Requirements

### Requirement: The pre-synthesis asset check does not require the Mandarin jieba HMM tables

**Reason**: Its scenario "A Mandarin install stages no jieba HMM tables" no longer holds: install now stages them (#1453).
**Migration**: Replaced by "A Mandarin install stages the jieba HMM tables, and synthesis does not require them", which keeps the not-required half unchanged.

## ADDED Requirements

### Requirement: A Mandarin install stages the jieba HMM tables, and synthesis does not require them

`kesha install --tts zh` SHALL stage the Mandarin jieba HMM tables (`jieba_hmm_start.bin`, `jieba_hmm_trans.bin`, `jieba_hmm_emit.bin`) into the Mandarin bundle's `g2p/` directory, each downloaded through the verified downloader against a pinned SHA-256. The pre-synthesis asset check SHALL NOT require them: their absence degrades Mandarin segmentation to FMM rather than blocking synthesis, so an install made before the tables were staged keeps working.

#### Scenario: Maks synthesizes Mandarin without the jieba HMM tables

- GIVEN `kesha install --tts zh` has staged the Mandarin bundle on darwin-arm64
- AND the jieba HMM tables are absent
- WHEN Maks runs `kesha say --voice zh-zm_050 "你好"`
- THEN the asset check reports nothing missing and audio is written
- AND the process exits 0

#### Scenario: A Mandarin install stages the jieba HMM tables

- GIVEN the machine is darwin-arm64
- WHEN Ira runs `kesha install --tts zh`
- THEN `jieba_hmm_start.bin`, `jieba_hmm_trans.bin` and `jieba_hmm_emit.bin` are in the Mandarin bundle's `g2p/` directory, each matching its pinned SHA-256
- AND the process exits 0

#### Scenario: Mandarin synthesis uses HMM segmentation after install

- GIVEN `kesha install --tts zh` has run on darwin-arm64
- WHEN Maks runs `kesha say --voice zh-zm_050 "你好世界"`
- THEN stderr does not contain `HMM segmentation disabled`
- AND no network request is made

> *Technical Note — upstream reads the tables from `<repoDir>/g2p/` and publishes them
> under `ANE-zh/assets/` (`KokoroAneConstants.jiebaHmm*File`, FluidAudio 0.15.7).
> kesha lists them in `rust/src/models/manifest.rs::ANE_ZH_HMM_ASSETS`, apart from
> `ANE_ZH_G2P_ASSETS`, because `missing_kokoro_assets` checks the latter. Without them
> `ensureMandarinJiebaHmm` fails on the offline registry base and segmentation falls
> back to FMM (#1433).*
