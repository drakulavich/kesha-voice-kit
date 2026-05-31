# README Optimization — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or execute inline. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Reorder `README.md` important→less for CLI end users, trim to common-case, relocate depth to `docs/`. No information lost.

**Spec:** `docs/superpowers/specs/2026-05-31-readme-optimization-design.md`

**Approach:** Content move, not code. Create the new docs FIRST (so README pointers resolve), then rewrite the README, then verify links + `bun test`/`tsc`. Commit per logical group.

---

### Task 1: Create `docs/docker.md`

**Files:** Create `docs/docker.md`

- [ ] Move the README "## Docker" section verbatim (GHCR `docker run … install` + `… audio.ogg`, the `kesha-cache` volume note, and the `docker compose run` variant). Add an H1 `# Docker` and a one-line intro ("Linux x64 CLI image, published to GHCR.").
- [ ] Commit: `docs: add docs/docker.md (extracted from README)`

### Task 2: Create `docs/mcp.md`

**Files:** Create `docs/mcp.md`

- [ ] Move the README "## MCP server" section verbatim: `kesha mcp` description, the tool list (`transcribe_audio`, `synthesize_speech`, `list_voices`, `list_languages`), the base config JSON, the per-client `<details>` blocks (Claude Code, Codex, Gemini CLI, Cursor), and the "models not installed" note. H1 `# MCP server`.
- [ ] Commit: `docs: add docs/mcp.md (extracted from README)`

### Task 3: Create `docs/api.md`

**Files:** Create `docs/api.md`

- [ ] Move the "## Programmatic API" snippet. Add a short paragraph naming the `@drakulavich/kesha-voice-kit/core` export and pointing to the TS types in `src/lib.ts` for the full surface. H1 `# Programmatic API`.
- [ ] Commit: `docs: add docs/api.md (extracted from README)`

### Task 4: Create `docs/local-stats.md`

**Files:** Create `docs/local-stats.md`

- [ ] Move the "## Local Stats privacy and lifecycle" section verbatim: the `kesha stats …` command table, the "stores only / never stores" paragraphs, retention/reset/vacuum semantics. H1 `# Local Stats — privacy & lifecycle`.
- [ ] Commit: `docs: add docs/local-stats.md (extracted from README)`

### Task 5: Fold depth into `docs/architecture.md` and `docs/tts.md` (verify-first)

**Files:** Modify `docs/architecture.md`, `docs/tts.md`

- [ ] Read `docs/architecture.md`. If the README's ASCII runtime diagram + "What's Inside" model table + cache-boundary note are NOT already represented, append them under a clear heading. If already covered, skip (the README will just link). Do not duplicate.
- [ ] Read `docs/tts.md`. Ensure the README's Russian-abbrev, English-acronym, Russian word-stress, and SSML-prosody subsections + the `### Examples` block are present there. Add only the parts that are unique to the README (much already exists — the README already deep-links into `tts.md` anchors). Preserve existing anchors referenced by the README (`#russian-abbreviation-auto-expansion`, `#english-acronym-auto-expansion`).
- [ ] Commit: `docs: absorb README architecture/tts depth into docs/`

### Task 6: Rewrite `README.md`

**Files:** Modify `README.md`

- [ ] Rewrite per the spec's target structure (Hero → Quick Start → STT → TTS → Languages → Performance → Other install methods → Integrations → More/docs-index+privacy → Contributing/License). Keep hero, perf, languages, integrations close to current. Trim STT (VAD/diarize → short + links) and TTS hard (3 say commands + format trio + 1-line routing note; everything else → `docs/tts.md`). Collapse install methods to one line each. Fold Requirements into Quick Start. Move Architecture diagram + What's Inside to the docs index pointer. Add MCP bullet to Integrations → `docs/mcp.md`. Add the 2–3 line privacy blurb → `docs/local-stats.md`.
- [ ] Keep all command examples copy-pasteable and correct against the current CLI; Bun-only guidance (no `npm i -g`).
- [ ] Commit: `docs: restructure README — human-first ordering, trim to docs/`

### Task 7: Verify

**Files:** none

- [ ] Link check: every `docs/*.md` / repo-relative link in the new README resolves (`grep -oE '\]\(([^)]+)\)' README.md` → confirm each path exists). Confirm `tts.md` anchors still exist.
- [ ] `bunx tsc --noEmit` clean; `bun test` (no test asserts README; the lone diarize-cold-compile e2e may flake — re-run once if it's the only fail).
- [ ] `wc -l README.md` ≤ ~250.
- [ ] Open PR `docs/readme-optimize` → main; wait for CI + Greptile; address P1/P2; merge after green + ≥4/5.

---

## Self-review

- **Spec coverage:** Tasks 1–4 = the four new docs; Task 5 = architecture/tts fold; Task 6 = README rewrite (all 10 target sections + Requirements fold + privacy blurb); Task 7 = acceptance criteria (links, tests, line count). Covered.
- **No placeholders:** each task names exact files + exact content to move.
- **Ordering:** docs created before README rewrite so pointers resolve at review time. Verify-first on architecture/tts avoids duplication.
