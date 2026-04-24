# README Trim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink `README.md` from ~247 to ~100 lines by extracting advanced/operational sections to dedicated pages under `docs/`.

**Architecture:** Docs-only change. No code or tests. Move content verbatim in per-section commits so each step is independently reviewable and revertible. README keeps one-line pointers to every moved section so nothing becomes invisible.

**Tech Stack:** Markdown. Git.

**Spec:** [`docs/superpowers/specs/2026-04-24-readme-trim-design.md`](../specs/2026-04-24-readme-trim-design.md)

---

## Working assumptions

- Branch `docs/readme-trim` already exists (created during spec commit `849cf3f`).
- All work happens from the repo root: `/Users/anton/Personal/repos/parakeet-cli`.
- "Verbatim" means the moved markdown is copied without editing prose, examples, or issue links. The only permitted edit to moved content is demoting the section's `##` heading to `#` when it becomes a standalone file's H1.
- README keeps image paths (`assets/logo.png`, `assets/benchmark.svg`) at repo-root-relative paths. New docs pages that reference the benchmark link to the existing root-level `BENCHMARK.md` rather than re-embedding images.

---

### Task 1: Create `docs/vad.md`

**Files:**
- Create: `docs/vad.md`

- [ ] **Step 1: Create the file with moved content**

Copy the current README block starting at `### Long / silence-heavy audio: \`--vad\`` (line ~104) through its last line (the one ending `#128 (base) and #187 (auto-trigger)`). Promote the heading to `# Voice Activity Detection (VAD)` and add a one-line intro.

```markdown
# Voice Activity Detection (VAD)

For meetings, lectures, and podcasts, enable Silero VAD so Parakeet only sees the speech bits. Segment boundaries land at natural speech starts/ends instead of arbitrary cuts, and long silences are skipped entirely.

```bash
kesha install --vad                   # one-time, ~2.3MB
kesha lecture.m4a                     # auto-on when audio ≥ 120s and VAD installed
kesha --vad short-clip.ogg            # force VAD on any input
kesha --no-vad meeting.m4a            # force VAD off even on long audio
```

Auto-triggers at 120 s so voice messages (< 30 s of near-pure speech) stay on the fast path. If you have long audio without VAD installed, Kesha prints a one-time stderr hint. Defaults: threshold 0.5, min-speech 250 ms, min-silence 100 ms, 30 ms edge padding. See issues [#128](https://github.com/drakulavich/kesha-voice-kit/issues/128) (base) and [#187](https://github.com/drakulavich/kesha-voice-kit/issues/187) (auto-trigger).
```

- [ ] **Step 2: Verify the file exists and renders**

Run: `wc -l docs/vad.md && head -1 docs/vad.md`
Expected: ~12 lines; first line is `# Voice Activity Detection (VAD)`.

- [ ] **Step 3: Commit**

```bash
git add docs/vad.md
git commit -m "docs: extract VAD section to docs/vad.md"
```

---

### Task 2: Create `docs/tts.md`

**Files:**
- Create: `docs/tts.md`

- [ ] **Step 1: Create the file with moved content**

Concatenate three current README sections into one page, preserving their subsections as `## ...`:

1. The `## Text-to-Speech` intro + `kesha say` examples + voices bullet list (README lines ~118–136).
2. The `### macOS system voices` block (~138–150).
3. The `### SSML (preview)` block including the tag table and opt-in note (~153–169).

Promote the top `## Text-to-Speech` heading to `# Text-to-Speech`. Keep both nested `###` headings as `##`.

The file starts like this (full content copied verbatim from current README, headings adjusted):

```markdown
# Text-to-Speech

Kesha speaks back via Kokoro-82M (English) and Piper (Russian). Voice is auto-picked from the input text's language — `en` routes to Kokoro, `ru` to Piper. Pass `--voice` to override.

[... rest of the TTS examples ...]

## macOS system voices

[... existing macOS voices content verbatim ...]

## SSML (preview)

[... existing SSML content verbatim, including the tag table ...]
```

- [ ] **Step 2: Verify content parity**

Run: `grep -c "kesha say" docs/tts.md`
Expected: ≥ 6 (matches the current README count for `kesha say` in these sections).

Run: `grep -E "macos-|--ssml|<break" docs/tts.md | wc -l`
Expected: ≥ 4 (ensures macOS, SSML, and break-tag examples all landed).

- [ ] **Step 3: Commit**

```bash
git add docs/tts.md
git commit -m "docs: extract TTS, macOS voices, and SSML sections to docs/tts.md"
```

---

### Task 3: Create `docs/openclaw.md`

**Files:**
- Create: `docs/openclaw.md`

- [ ] **Step 1: Create the file with moved content**

Copy the current README's `## OpenClaw Integration` block (~45–65) into a new file. Promote `##` to `# OpenClaw Integration`.

Content to copy (verbatim from current README):

```markdown
# OpenClaw Integration

Kesha Voice Kit ships as a plugin for [OpenClaw](https://github.com/openclaw/openclaw) — give your LLM agent ears. No API keys, everything runs locally on your machine.

```bash
bun add -g @drakulavich/kesha-voice-kit && kesha install
openclaw plugins install @drakulavich/kesha-voice-kit
openclaw config set tools.media.audio.models \
  '[{"type":"cli","command":"kesha","args":["--format","transcript","{{MediaPath}}"],"timeoutSeconds":15}]'
```

> If audio transcription is not already enabled: `openclaw config set tools.media.audio.enabled true`

Your agent receives a voice message in Telegram/WhatsApp/Slack, Kesha transcribes it locally, and the agent sees enriched context:

```
Таити, Таити! Не были мы ни в какой Таити! Нас и тут неплохо кормят.
[lang: ru, confidence: 1.00]
```

Manage the plugin with `openclaw plugins list`, `openclaw plugins disable kesha-voice-kit`, or `openclaw plugins uninstall kesha-voice-kit`.
```

- [ ] **Step 2: Verify**

Run: `grep -c "openclaw" docs/openclaw.md`
Expected: ≥ 5.

- [ ] **Step 3: Commit**

```bash
git add docs/openclaw.md
git commit -m "docs: extract OpenClaw integration to docs/openclaw.md"
```

---

### Task 4: Create `docs/model-mirror.md`

**Files:**
- Create: `docs/model-mirror.md`

- [ ] **Step 1: Create the file with moved content**

Copy the current README's `### Air-gapped / corporate mirrors` block (~33–43). Promote `###` to `# Air-gapped / corporate mirrors` and prepend a one-line intro that fits a standalone page.

```markdown
# Air-gapped / corporate mirrors

Set `KESHA_MODEL_MIRROR` to redirect all HuggingFace model downloads to an internal mirror ([#121](https://github.com/drakulavich/kesha-voice-kit/issues/121)). The HF path hierarchy is preserved, so any HTTP-readable mirror populated with `wget --mirror` or `rsync` works:

```bash
export KESHA_MODEL_MIRROR=https://models.corp.internal/kesha
kesha install        # ASR + lang-id + TTS models fetch from your mirror
kesha status         # confirms the active Mirror URL
```

Unset / empty falls back to `huggingface.co` with no regression. The engine binary itself still comes from GitHub Releases — this env var only redirects model downloads.
```

- [ ] **Step 2: Verify**

Run: `grep -c "KESHA_MODEL_MIRROR" docs/model-mirror.md`
Expected: ≥ 2.

- [ ] **Step 3: Commit**

```bash
git add docs/model-mirror.md
git commit -m "docs: extract model-mirror section to docs/model-mirror.md"
```

---

### Task 5: Rewrite `README.md`

**Files:**
- Modify: `README.md` (full replacement)

This is the largest task — it replaces the README with the slim version. All moved content already lives under `docs/` (Tasks 1–4), so this task only deletes from README and adds pointers.

- [ ] **Step 1: Replace the file**

Overwrite `README.md` with exactly this content (preserves the hero block, badges, quick-start, core CLI, TTS teaser, perf chart, models table, compact languages, integrations pointers, programmatic API, requirements, contributing, license):

````markdown
<p align="center">
  <img src="assets/logo.png" alt="Kesha Voice Kit" width="200">
</p>

<h1 align="center">Kesha Voice Kit</h1>

<p align="center">
  <a href="https://github.com/drakulavich/kesha-voice-kit/actions/workflows/ci.yml"><img src="https://github.com/drakulavich/kesha-voice-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@drakulavich/kesha-voice-kit"><img src="https://img.shields.io/npm/v/@drakulavich/kesha-voice-kit" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun"></a>
</p>

<p align="center"><b>Open-source voice toolkit.</b> Optimized for Apple Silicon (CoreML), works on any platform (ONNX fallback).<br>A collection of small, fast, open-source audio models — packaged as CLI tools and an <a href="https://github.com/openclaw/openclaw">OpenClaw</a> skill for LLM agents.</p>

- **Speech-to-text** — 25 languages, ~15x faster than Whisper on Apple Silicon, ~2.5x on CPU
- **Text-to-speech** — Kokoro (EN) + Piper (RU) + macOS system voices, SSML preview
- **Rust engine** — single 20MB binary, no ffmpeg, no Python, no native Node addons
- **OpenClaw-ready** — plug into your LLM agent as a voice processing skill

## Quick Start

Runtime: **[Bun](https://bun.sh)** >= 1.3.0.

```bash
curl -fsSL https://bun.sh/install | bash   # skip if Bun is already installed

bun install -g @drakulavich/kesha-voice-kit
kesha install       # downloads engine + models
kesha audio.ogg     # transcript to stdout
```

Air-gapped or behind a corporate mirror? See [docs/model-mirror.md](docs/model-mirror.md).

## Speech-to-text

```bash
kesha audio.ogg                            # transcribe (plain text)
kesha --format transcript audio.ogg        # text + language/confidence
kesha --format json audio.ogg              # full JSON with lang fields
kesha --toon audio.ogg                     # compact LLM-friendly TOON
kesha --verbose audio.ogg                  # show language detection details
kesha --lang en audio.ogg                  # warn if detected language differs
kesha status                               # show installed backend info
```

Multiple files — headers per file, like `head`:

```bash
$ kesha freedom.ogg tahiti.ogg
=== freedom.ogg ===
Свободу попугаям! Свободу!

=== tahiti.ogg ===
Таити, Таити! Не были мы ни в какой Таити! Нас и тут неплохо кормят.
```

Stdout: transcript. Stderr: errors. Pipe-friendly. Also available as `parakeet` command (backward-compatible alias).

For long / silence-heavy audio, use `--vad` (auto-on past 120 s). Details: [docs/vad.md](docs/vad.md).

## Text-to-speech

Kesha speaks back via Kokoro-82M (English) and Piper (Russian) — voice auto-picks from the text's language:

```bash
kesha install --tts                      # ~490MB (Kokoro + Piper RU + ONNX G2P, opt-in)
kesha say "Hello, world" > hello.wav
kesha say "Привет, мир" > privet.wav     # auto-routes to ru-denis
```

macOS system voices, SSML, voice listing, and the full voice catalogue: [docs/tts.md](docs/tts.md).

## Performance

> **~15x faster than Whisper** on Apple Silicon (M3 Pro), **~2.5x faster** on CPU

Compared against Whisper `large-v3-turbo` — all engines auto-detect language.

![Benchmark: openai-whisper vs faster-whisper vs Kesha Voice Kit](assets/benchmark.svg)

See [BENCHMARK.md](BENCHMARK.md) for the full per-file breakdown (Russian + English).

## What's Inside

| Model | Task | Size | Source |
|---|---|---|---|
| NVIDIA Parakeet TDT 0.6B v3 | Speech-to-text | ~2.5GB | [HuggingFace](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| SpeechBrain ECAPA-TDNN | Audio language detection | ~86MB | [HuggingFace](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa) |
| Apple NLLanguageRecognizer | Text language detection | built-in | macOS system framework |
| Silero VAD v5 (opt-in) | Voice activity detection | ~2.3MB | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) |
| Kokoro-82M / Piper (opt-in) | Text-to-speech | ~490MB | [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) · [Piper](https://github.com/rhasspy/piper) |

All models run through `kesha-engine` — a Rust binary using [FluidAudio](https://github.com/FluidInference/FluidAudio) (CoreML) on Apple Silicon and [ort](https://github.com/pykeio/ort) (ONNX Runtime) on other platforms.

Audio decoding via [symphonia](https://github.com/pdeljanov/Symphonia) — WAV, MP3, OGG/Opus, FLAC, AAC, M4A. No ffmpeg.

## Languages

- **Speech-to-text (25):** Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian.
- **Audio language detection (107):** [full list](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa).

## Integrations

- **OpenClaw** — give your LLM agent ears. Install & config: [docs/openclaw.md](docs/openclaw.md).
- **Raycast** (macOS) — transcribe selected audio & speak clipboard from the launcher. Source + install: [`raycast/`](raycast/).

## Programmatic API

```typescript
import { transcribe, downloadModel } from "@drakulavich/kesha-voice-kit/core";

await downloadModel();                       // install engine + models
const text = await transcribe("audio.ogg");  // transcribe
```

## Requirements

- [Bun](https://bun.sh) >= 1.3
- macOS arm64, Linux x64, or Windows x64

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Made with 💛🩵 and 🥤 energy under MIT License
````

- [ ] **Step 2: Verify line count and key keywords**

Run: `wc -l README.md`
Expected: 100 ± 20 (the content above is ~115 lines).

Run: `grep -E "docs/vad\.md|docs/tts\.md|docs/openclaw\.md|docs/model-mirror\.md|raycast/" README.md`
Expected: 5 pointer lines, one per moved destination.

Run: `grep -E "KESHA_MODEL_MIRROR|<speak>|AVSpeechSynthesizer|openclaw plugins install" README.md`
Expected: no matches (those details now live under `docs/` only, confirming the move was complete, not duplicated).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: trim README to essentials; link to docs/ for deep-dives"
```

---

### Task 6: Link check

**Files:** none modified — verification only.

- [ ] **Step 1: Enumerate relative links in README and docs**

Run:
```bash
grep -oE '\]\(\.?\.?/?[A-Za-z0-9_./-]+\)' README.md docs/vad.md docs/tts.md docs/openclaw.md docs/model-mirror.md | sort -u
```

- [ ] **Step 2: Verify each target resolves**

For every link target that is a repo-relative path (not `http...`), confirm the file exists:

```bash
for f in assets/logo.png assets/benchmark.svg BENCHMARK.md CONTRIBUTING.md docs/vad.md docs/tts.md docs/openclaw.md docs/model-mirror.md raycast/README.md; do
  test -e "$f" && echo "OK  $f" || echo "MISS $f"
done
```

Expected: every line says `OK`.

- [ ] **Step 3: Content-parity grep**

Ensure nothing critical vanished — each keyword must still appear somewhere in the tree:

```bash
for kw in KESHA_MODEL_MIRROR '--vad' '--ssml' 'macos-' 'openclaw plugins install' 'parakeet' 'Kokoro' 'Piper'; do
  matches=$(grep -rl --include='*.md' "$kw" README.md docs/ 2>/dev/null | wc -l | tr -d ' ')
  echo "$kw → $matches file(s)"
done
```

Expected: every keyword matches ≥ 1 file.

- [ ] **Step 4: If all checks pass, no commit needed**

If a check fails, fix the link/content inline and commit with message `docs: fix broken link/content parity after README trim`.

---

### Task 7: Push branch and open PR (optional — ask user first)

**Files:** none.

- [ ] **Step 1: Ask the user** whether to push `docs/readme-trim` and open a PR, or leave it local for further review.

- [ ] **Step 2: If user approves, push:**

```bash
git push -u origin docs/readme-trim
```

- [ ] **Step 3: If user approves, open PR:**

```bash
gh pr create --title "docs: trim README to essentials; move deep-dives under docs/" --body "$(cat <<'EOF'
## Summary
- README shrinks from ~247 → ~115 lines
- VAD, TTS (incl. macOS voices + SSML), OpenClaw, and model-mirror sections move to dedicated pages under \`docs/\`
- All moved content is verbatim — no prose rewrites

## Test plan
- [ ] Preview README and new \`docs/*.md\` on GitHub; tables, code fences, and images render
- [ ] All relative links resolve
- [ ] Every feature keyword (\`KESHA_MODEL_MIRROR\`, \`--vad\`, \`--ssml\`, \`macos-\`, \`openclaw plugins install\`) still appears somewhere in the tree

Spec: \`docs/superpowers/specs/2026-04-24-readme-trim-design.md\`
EOF
)"
```

---

## Self-review

- **Spec coverage:** Tasks 1–4 create each of the four docs pages called out in the spec. Task 5 implements the target README structure (hero, quick start, STT, TTS teaser, perf, models table, compact languages, integrations, programmatic API, requirements, contributing, license). Task 6 validates content parity. All spec items covered.
- **Placeholders:** none. Each task has exact file paths, full content for docs pages, and full replacement content for README.
- **Type consistency:** N/A (docs-only).
- **Reversibility:** per-section commits mean any single extraction can be reverted without touching the others.
