# README Optimization — Design

**Date:** 2026-05-31
**Status:** Approved (design)
**Goal:** Restructure `README.md` for a human CLI end-user reading top-to-bottom: order blocks important → less important, trim each block to the common case, and relocate depth to `docs/`. No information is lost — bulk moves to docs, it is not deleted.

## Decisions (from brainstorm)

- **Primary audience:** CLI end users. The first screen optimizes for "what is this → install → first transcribe + say".
- **Trim level:** Moderate. Target ~220 lines (from 509). Keep a compact "other install methods" subsection, an Integrations signpost, and a 3-row perf table inline; deep dives go to `docs/`.
- **Sections with no existing doc** (Docker, MCP config, Programmatic API): create the docs and link from README.
- **Privacy / Local Stats:** keep a 2–3 line trust blurb inline + link to a new `docs/local-stats.md`; do not hide it entirely.

## Target README structure (top → bottom)

1. **Hero** — logo, title, badges, the one-line value prop (`<b>Give your local tools and LLM agents a voice.</b>` + the current sub-line), the four highlight bullets (transcribe / speak / agents / small engine), `Product positioning` link, demo gif. *(keep ~as-is — this block already leads well)*
2. **Quick Start** — Bun prereq + the canonical path: `bun add -g … && kesha install && kesha audio.ogg`. Keep the Bun-install one-liners and the model-mirror pointer. *(keep, tighten)*
3. **Speech-to-text** — the common command set (plain / transcript / json / toon / status), multi-file example, the "stdout/stderr pipe-friendly" line. Keep VAD + diarization as **short** paragraphs with doc links (trim the inline detail). *(trim)*
4. **Text-to-speech** — `install --tts`, the 3 canonical `say` commands (en, auto-routed ru, explicit voice), output-format trio (wav/ogg-opus/flac) with the one-line FLAC rationale, and a **one-line** auto-routing note. Move Russian abbreviations / English acronyms / Russian word stress / SSML prosody / the second `### Examples` block to `docs/tts.md`. *(trim hard — currently ~80 lines → ~25)*
5. **Languages** — keep the STT one-liner + the lang-detect "full list" link. *(keep, 2 lines)*
6. **Performance** — keep the headline, the one-line "vs Whisper large-v3-turbo", the benchmark SVG, and the BENCHMARK.md link. *(keep, already compact)*
7. **Other install methods** — collapse Homebrew / Linux packages / Docker / Nix into one subsection: a single line each linking its doc (`docs/homebrew.md`, `docs/linux-packages.md`, **new** `docs/docker.md`, `docs/nix-install.md`). Shell completions + manpage become a single line showing the self-documenting commands (`kesha completions bash|zsh|fish`, `kesha manpage`) — no separate doc, since the commands print install instructions context themselves. *(collapse ~90 lines → ~10)*
8. **Integrations** — keep the existing 3-bullet signpost (OpenClaw / Hermes / Raycast) and **add MCP** as a fourth bullet pointing to the new `docs/mcp.md`. *(keep + 1 line)*
9. **More / docs index** — short bulleted index: Programmatic API (`docs/api.md`, new), Architecture (`docs/architecture.md`), Diagnostics & error codes (`docs/diagnostic-logs.md`, `docs/errors.md`), Model mirror (`docs/model-mirror.md`), Use cases (`docs/use-cases.md`). Include the **privacy blurb**: 2–3 lines (Stats off by default, local-only SQLite, opt-in, content-free, never networked) + link to new `docs/local-stats.md`.
10. **Contributing · License** — keep the Contributing block (trim its inline doc list, since the docs index now covers most) and the License line.

The current **Requirements** section folds into Quick Start (Bun ≥ 1.3 + platform line). The current **Architecture** ASCII diagram + **What's Inside** model table both move to `docs/architecture.md` (the README keeps a one-line Architecture pointer in the docs index). *(The "What's Inside" model table is reference depth, not first-screen material.)*

## Docs created or extended

| Doc | New? | Content |
|-----|------|---------|
| `docs/docker.md` | new | The current Docker section verbatim (GHCR run commands, cache volume note, compose.yml usage). |
| `docs/mcp.md` | new | The current MCP server section verbatim (`kesha mcp`, the tool list, client config JSON, the per-client `<details>` for Claude Code / Codex / Gemini / Cursor, the "models not installed" note). |
| `docs/api.md` | new | The Programmatic API snippet + a short note on the `@drakulavich/kesha-voice-kit/core` export surface. |
| `docs/local-stats.md` | new | The full Local Stats privacy & lifecycle section verbatim (the `kesha stats …` command table, what's stored / never stored, retention/reset semantics). |
| `docs/architecture.md` | extend | Absorb the README's ASCII runtime diagram + "What's Inside" model table + cache-boundary note, if not already represented. (Verify before duplicating; link, don't double.) |
| `docs/tts.md` | extend | Absorb the README's Russian-abbrev / English-acronym / word-stress / SSML-prosody subsections + the `### Examples` block, if not already present. (Much already exists there; add only what's unique.) |

## Constraints / non-goals

- **No information deleted** — every trimmed/removed inline block lands in a doc (existing or new). A reader can still reach all of it in ≤1 click.
- **All existing inline links keep working**; new pointers use repo-relative paths consistent with current style (`docs/x.md`).
- **Bun-only user guidance** preserved (never `npm i -g`).
- **Do not** restructure `docs/` beyond adding the four new files + extending `architecture.md`/`tts.md`. No renames of existing docs.
- **Do not** touch the brand voice / male-default messaging.
- Keep the privacy/trust posture visible (the blurb stays in the README).
- Target ~220 README lines is a guide, not a hard limit; correctness and completeness of relocation win over an exact count.

## Acceptance criteria

1. `README.md` follows the section order above; ≤ ~250 lines.
2. New docs exist and contain the relocated content; no relocated content is lost.
3. Every README link resolves (relative paths valid); no orphaned references.
4. `bun test && bunx tsc --noEmit` pass (no test asserts README content; sanity only).
5. The hero, quick-start, STT, and TTS common-case commands remain copy-pasteable and correct against the current CLI.
6. Privacy blurb present inline + links to `docs/local-stats.md`.
