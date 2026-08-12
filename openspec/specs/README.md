# Kesha Voice Kit — Baseline Specifications

This directory is the **baseline spec corpus**: it captures how Kesha Voice Kit
*actually behaves today*, one capability per directory, so future work can be
proposed as OpenSpec change deltas against a trustworthy reference instead of
tribal knowledge.

> **Disclaimer (living document).** These specs describe the current release and
> are updated whenever behavior changes. If a spec and the code disagree, the code
> is the bug *or* the spec is stale — either way, open an issue; don't silently
> trust one side.

## How to read these specs

Every spec follows the same shape:

- **Purpose** — what the capability does and for whom.
- **Non-Goals** — what it deliberately does *not* do (so nobody "fixes" that).
- **Requirements** — verifiable contracts (`SHALL`), each with at least one
  happy-path and one error/edge **Scenario** in Given/When/Then form.
- **Technical Notes** — constants, tables, and `file:line` traceability refs,
  kept out of the requirement text so contracts stay readable.
- **Open Issues** — known gaps, tracked by GitHub issue where one exists.

Terminology is canonical: every capitalized term of art (Engine, Backend,
Voice id, Model cache, …) is defined once in [GLOSSARY.md](GLOSSARY.md) and used
verbatim everywhere else.

## Personas

Specs reference these named personas instead of a generic "user":

- **Ira, the CI engineer** — runs `kesha` headless in pipelines and scripts.
  Cares about exit codes, stdout purity, `--quiet`, JSON/TOON output, and that
  nothing ever triggers a surprise multi-gigabyte download.
- **Maks, the macOS power user** — Apple Silicon laptop, voice-notes in Telegram
  through the OpenClaw plugin, listens to `kesha say` replies. Cares about fast
  local transcription, Russian + English TTS quality, and diarized meeting notes.
- **Sona, the agent author** — embeds Kesha in an LLM agent via the MCP server
  and the `./core` programmatic API. Cares about stable tool schemas, structured
  errors, and resource cleanup.

## Capabilities

| Spec | Covers |
|---|---|
| [transcription](transcription/spec.md) | Default `kesha <file>` command: batch, output formats, VAD, exit codes |
| [audio-ingest](audio-ingest/spec.md) | Decode, mono mix, 16 kHz resample, duration probes, input rejection |
| [speaker-diarization](speaker-diarization/spec.md) | `--speakers` labels on transcription segments |
| [language-detection](language-detection/spec.md) | Audio and text language identification |
| [tts-synthesis](tts-synthesis/spec.md) | `kesha say`: voices, engines, formats, SSML, normalization |
| [installation](installation/spec.md) | `kesha install` / `kesha init`: engine + model downloads, integrity |
| [release-channels](release-channels/spec.md) | Stable vs alpha: tag grammar, opt-in install, derived versions, shared publish path, 30-day prune |
| [cli-distribution](cli-distribution/spec.md) | How `kesha` itself is installed: npm, Homebrew, `.deb`/`.rpm`, container, Nix |
| [audio-recording](audio-recording/spec.md) | `kesha record`: microphone capture to WAV |
| [diagnostics](diagnostics/spec.md) | `doctor`, `status`, `logs`, `stats`, `support-bundle` |
| [cli-shell-integration](cli-shell-integration/spec.md) | Global flags, `--version`/`--help`, color/quiet rules, completions, manpage |
| [process-lifecycle](process-lifecycle/spec.md) | Interruption, Engine process-tree termination, signal exit codes |
| [mcp-server](mcp-server/spec.md) | `kesha mcp`: MCP tools and audio resources |
| [programmatic-api](programmatic-api/spec.md) | `@drakulavich/kesha-voice-kit/core` exports |
| [engine-contract](engine-contract/spec.md) | CLI ↔ `kesha-engine` boundary: capabilities, error codes, env vars |
| [openclaw-plugin](openclaw-plugin/spec.md) | Bundled OpenClaw plugin: CLI-subprocess transcription for agents |
| [raycast-extension](raycast-extension/spec.md) | Raycast **Dictate to Clipboard**: recording lifecycle, idle auto-stop, clipboard |

## Validation

```bash
openspec spec list                    # enumerate capabilities
bun run check:specs                   # structural validation — must exit 0
```

`check:specs` is the same `openspec validate --specs --strict` call, with the
tool version pinned. CI runs it in the `openspec-validate` lane whenever
`openspec/**` changes. It is a *structural* gate — headings, one scenario per
requirement, `SHALL`/`MUST` in the requirement text — and knows nothing about
whether a spec still matches the code.
