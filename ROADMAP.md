# Roadmap

Where Kesha Voice Kit is heading. Grouped by horizon, not hard dates — **Now** is
in flight, **Next** is committed near-term, **Later** is planned but unscheduled.
For *why* past platform/model choices were made (and reversed), see the
[decision log](docs/decision-log.md).

This is a living document; open issues are the source of truth, and this page is a
curated lens over them. Suggestions welcome via an issue.

## Now (in flight)

- **Raycast integration on macOS** — drive transcription/TTS from Raycast's launcher
  without a terminal; extension scaffold lives in `raycast/`.
  ([#145](https://github.com/drakulavich/kesha-voice-kit/issues/145))

## Next (committed, near-term)

- **Product polish** — reproducible benchmark harness, cache backup/restore, and
  Linux/Windows real-synth release smoke.
  ([#464](https://github.com/drakulavich/kesha-voice-kit/issues/464))

## Later (planned, unscheduled)

- **Serve mode + observability** — long-running `kesha serve` with warmed model state,
  a Prometheus/OpenMetrics endpoint, and `/healthz`.
  ([#460](https://github.com/drakulavich/kesha-voice-kit/issues/460))
- **Native-script multilingual TTS (hi/ja)** — es/fr/it/pt landed
  ([#212](https://github.com/drakulavich/kesha-voice-kit/issues/212)) and Chinese is
  supported natively, but Hindi and Japanese still fail fast on native-script input;
  they need a transliteration (Devanagari→IAST, kana→romaji) G2P path.
  ([#492](https://github.com/drakulavich/kesha-voice-kit/issues/492))
