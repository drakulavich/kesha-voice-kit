# Roadmap

Where Kesha Voice Kit is heading. Grouped by horizon, not hard dates — **Now** is
in flight, **Next** is committed near-term, **Later** is planned but unscheduled.
For *why* past platform/model choices were made (and reversed), see the
[decision log](docs/decision-log.md).

This is a living document; open issues are the source of truth, and this page is a
curated lens over them. Suggestions welcome via an issue.

## Now (in flight)

- **Contributor + user docs** — architecture map, dev-setup, use-case recipes, this
  roadmap + decision log. ([#463](https://github.com/drakulavich/kesha-voice-kit/issues/463))
- **Raycast integration on macOS** — drive transcription/TTS from Raycast.
  ([#145](https://github.com/drakulavich/kesha-voice-kit/issues/145))
- **Fix Kokoro `--rate` on CoreML** — speaking-rate currently ignored (silently) for
  `en-*` voices on the Apple Silicon build.
  ([#475](https://github.com/drakulavich/kesha-voice-kit/issues/475))

## Next (committed, near-term)

- **Structured error taxonomy** — consistent, machine-readable error kinds across the
  CLI and engine. ([#462](https://github.com/drakulavich/kesha-voice-kit/issues/462))
- **Product polish** — benchmark harness, cache backup/restore, release smoke
  hardening. ([#464](https://github.com/drakulavich/kesha-voice-kit/issues/464))
- **MCP server follow-ups** — mid-flight cancellation (thread `AbortSignal` into the
  engine subprocess) and richer voice metadata (macOS voice gender/name via a
  structured engine `--list-voices`). (follow-ups to
  [#473](https://github.com/drakulavich/kesha-voice-kit/issues/473))
- **Dependency maintenance** — routine Cargo/npm bumps.
  ([#432](https://github.com/drakulavich/kesha-voice-kit/issues/432))

## Later (planned, unscheduled)

- **Serve mode + observability** — long-running server interface with metrics/tracing.
  ([#460](https://github.com/drakulavich/kesha-voice-kit/issues/460))
- **Multi-language Kokoro (fr/it/es/pt)** — blocked: the originally-planned espeak-ng
  G2P was removed (see the [decision log](docs/decision-log.md)), so this needs a new
  no-system-deps G2P path before it can proceed.
  ([#212](https://github.com/drakulavich/kesha-voice-kit/issues/212))
