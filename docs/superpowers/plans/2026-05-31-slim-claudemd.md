# Slim CLAUDE.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move task-triggered runbooks out of the always-loaded `CLAUDE.md` into `docs/runbooks/*.md`, dropping it from ~53.7k to ~26k chars while losing nothing.

**Architecture:** Each extracted section moves **verbatim** into a topic runbook file. In `CLAUDE.md` it is replaced by its `###` heading + the one-sentence hard rule + a `See docs/runbooks/<topic>.md` pointer. Hard always-on safety/brand/workflow rules stay inline untouched.

**Tech Stack:** Markdown only. No code changes. Verification via `wc -c`, `grep`, and `git diff`.

**Spec:** `docs/superpowers/specs/2026-05-31-slim-claudemd-design.md`

---

## Working context

- Worktree: `.worktrees/slim-claudemd`, branch `chore/slim-claudemd` (already created off fresh `origin/main`).
- The Bash tool runs each command from the **repo root**, not the worktree. Either pass worktree-relative paths from root (`.worktrees/slim-claudemd/CLAUDE.md`) or prefix one-shot `cd` inside a single command. All paths below are written **relative to the worktree root**; prepend `.worktrees/slim-claudemd/` when running from the repo root.
- **Extraction technique (every task):** open `CLAUDE.md`, locate the named `###`/`##` section(s), cut the entire block (heading through the last line before the next same-or-higher-level heading), paste verbatim into the new runbook file under a top-of-file `# <Title>` + source note, then in `CLAUDE.md` replace the cut block with the retained pointer stub shown in the task.
- **Pointer stub format** (keeps the constraint in always-loaded context):

  ```markdown
  ### <ORIGINAL HEADING>

  <one-sentence hard rule, copied from the section's first imperative.>

  **Full procedure / details:** `docs/runbooks/<topic>.md`.
  ```

- **Do not touch** these inline sections: Project Overview, DEFAULT TTS VOICES MUST BE MALE, NEVER AUTO-DOWNLOAD, BUN-ONLY RUNTIME, PYTHON DEPENDENCIES IN A VENV, MAIN STAYS IN THE ROOT CHECKOUT, RELEASE-unrelated rules, NO SPECULATIVE FIELDS, ERROR HANDLING, BRANCH PROTECTION, WIP LABEL, LINK PRS TO ISSUES, DO NOT BLINDLY FORWARD CLI FLAGS, COREML BUILD TRIPLE, BUILD-ENGINE FEATURE MATRIX, WORKFLOW SHELL INJECTION, VERIFY THIRD-PARTY MODEL FORMATS WITH A SPIKE, PROMPT-INJECTION PATTERNS, Build Commands, Architecture, CI/CD, Code Style, Platform Requirements.

---

## File Structure

| File | Responsibility |
|---|---|
| `docs/runbooks/release.md` | Full release procedure, draft validation, npm publish, tag rules, Greptile mechanics |
| `docs/runbooks/rust-gotchas.md` | Deep Rust implementation lessons (clamp, ort, clippy, bindgen, VAD, fluidaudio, g2p) |
| `docs/runbooks/tts-internals.md` | Deep TTS engine/ONNX/SSML/voice-routing reference |
| `docs/runbooks/jj-git-lfs.md` | One-time jj + Git LFS setup and operational lessons |
| `docs/runbooks/openclaw-plugin.md` | OpenClaw plugin internals + ClawHub publish |
| `CLAUDE.md` | Hard always-on rules + one-line pointers (modified) |

Each runbook starts with:

```markdown
# <Title>

> Extracted from CLAUDE.md (chore/slim-claudemd, 2026-05-31) to keep the always-loaded
> instructions under Claude Code's 40k-char performance threshold. Read this when <trigger>.
```

---

### Task 1: Extract the release runbook

**Files:**
- Create: `docs/runbooks/release.md`
- Modify: `CLAUDE.md` (remove 8 sections, insert pointers)

Sections to move verbatim into `release.md`, in this order:
1. `### RELEASE PROCESS — CLI AND ENGINE ARE VERSIONED INDEPENDENTLY`
2. `### NPM PUBLISH IS AUTOMATED WITH PROVENANCE ATTESTATION`
3. `### TAG NAMES ARE ONE-USE`
4. `### RELEASE CHICKEN-AND-EGG — `integration-tests` SKIPS ON `release/*``
5. `### DRAFT RELEASE ASSET URLS ARE 404 TO ANONYMOUS CLIENTS — USE `gh release download``
6. `### `make smoke-test` ALONE DOES NOT VALIDATE A NEW ENGINE ...`
7. `### `bun link` DOES NOT OVERRIDE A GLOBALLY-INSTALLED PACKAGE — REMOVE FIRST`
8. The **Greptile comment mechanics** subsection only (the bulleted "Greptile comment mechanics:" block + the auto-merge/ScheduleWakeup paragraph) from `### GREPTILE PR REVIEW IS A GATE`. Leave the gate rule + the "Pattern:" / "Past incidents" bullets inline.

- [ ] **Step 1: Create `docs/runbooks/release.md`** with the header block (trigger: "cutting or publishing a release") followed by the 8 section blocks pasted verbatim, in the order above. Use `## ` for each instead of the original `### ` (they are now top-level within the runbook).

- [ ] **Step 2: Replace sections 1–7 in `CLAUDE.md` with pointer stubs.** Each keeps its original `### ` heading and one hard sentence. Examples:

  ```markdown
  ### RELEASE PROCESS — CLI AND ENGINE ARE VERSIONED INDEPENDENTLY

  `package.json#version` (CLI) and `package.json#keshaEngine.version` + `rust/Cargo.toml`
  (engine) are versioned independently; all releases go through PRs. The drift gate is
  `bun run check:versions`.

  **Full procedure (CLI-only / engine / beta / dispatch paths, draft-asset validation,
  known breaks):** `docs/runbooks/release.md`.
  ```

  ```markdown
  ### TAG NAMES ARE ONE-USE

  GitHub permanently reserves tag names after publish. Broken release → bump patch, cut a
  new tag; never tag "just to test". Details: `docs/runbooks/release.md`.
  ```

  (Write equivalent 1–2 sentence stubs for sections 2, 4, 5, 6, 7, each ending with `Details: \`docs/runbooks/release.md\`.`)

- [ ] **Step 3: Trim the Greptile section.** Under `### GREPTILE PR REVIEW IS A GATE`, delete the "Greptile comment mechanics:" block and the auto-merge/ScheduleWakeup paragraph; append `Re-review/auto-merge mechanics: \`docs/runbooks/release.md\`.` Leave the gate rule intact.

- [ ] **Step 4: Verify the move preserved content.** Pick distinctive strings and confirm each now lives in the runbook and is gone from CLAUDE.md (except the retained rule words):

  Run (from repo root):
  ```bash
  cd .worktrees/slim-claudemd
  for s in "v1.18.2-cli" "id-token: write" "GITHUB_TOKEN tag pushes" "false-green" "Confidence Score"; do
    printf '%-22s runbook=%s claude=%s\n' "$s" \
      "$(grep -c -F "$s" docs/runbooks/release.md)" \
      "$(grep -c -F "$s" CLAUDE.md)"
  done
  ```
  Expected: every string `runbook=1+` and `claude=0`.

- [ ] **Step 5: Commit**

  ```bash
  cd .worktrees/slim-claudemd
  git add docs/runbooks/release.md CLAUDE.md
  git commit -m "docs: extract release runbook from CLAUDE.md"
  ```

---

### Task 2: Extract the Rust gotchas runbook

**Files:**
- Create: `docs/runbooks/rust-gotchas.md`
- Modify: `CLAUDE.md`

Sections to move verbatim:
1. `### `f32::clamp` DIVERGENCE: USE BOUND CHECK, NOT `EPSILON``
2. `### `ort 2.0.0-rc.12` `Value::from_array` WANTS OWNED NDARRAYS`
3. `### CLIPPY `needless_update` BLOCKS `..Default::default()` IF ALL FIELDS ARE SPELLED`
4. `### BINDGEN ON LINUX NEEDS LIBCLANG_PATH`
5. `### SILERO VAD V5 NEEDS A 64-SAMPLE ROLLING CONTEXT`
6. `### `fluidaudio-rs 0.1.0` LACKS `transcribe_samples``
7. `### TESTS THAT STAGE A TEMPDIR CACHE MUST STAGE G2P TOO`

- [ ] **Step 1: Create `docs/runbooks/rust-gotchas.md`** with header (trigger: "writing or debugging Rust in `rust/`") + the 7 blocks verbatim (`## ` headings).

- [ ] **Step 2: Remove the 7 sections from `CLAUDE.md`.** These are deep lessons, not always-on rules — replace all 7 with a **single** pointer line appended to the `### VERIFY BEFORE PUSHING` section:

  ```markdown
  **Deep Rust gotchas** (clamp/EPSILON, ort owned ndarrays, clippy needless_update, bindgen
  LIBCLANG_PATH, Silero VAD 576, fluidaudio transcribe_samples, g2p tempdir staging):
  `docs/runbooks/rust-gotchas.md`.
  ```

- [ ] **Step 3: Verify.**
  ```bash
  cd .worktrees/slim-claudemd
  for s in "f32::EPSILON" "OwnedTensorArrayData" "needless_update" "LIBCLANG_PATH" "576" "transcribe_samples" "is_g2p_cached"; do
    printf '%-22s runbook=%s claude=%s\n' "$s" \
      "$(grep -c -F "$s" docs/runbooks/rust-gotchas.md)" "$(grep -c -F "$s" CLAUDE.md)"
  done
  ```
  Expected: each `runbook=1+`. `claude=0` for all except `LIBCLANG_PATH` (also appears in the COREML/macOS build-env lines, which stay) — confirm any remaining CLAUDE.md hit is **not** inside a removed gotcha.

- [ ] **Step 4: Commit**
  ```bash
  cd .worktrees/slim-claudemd
  git add docs/runbooks/rust-gotchas.md CLAUDE.md
  git commit -m "docs: extract Rust gotchas runbook from CLAUDE.md"
  ```

---

### Task 3: Extract the TTS internals runbook

**Files:**
- Create: `docs/runbooks/tts-internals.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create `docs/runbooks/tts-internals.md`** with header (trigger: "changing TTS synthesis, voices, G2P, or SSML"). Move the **deep-reference bullets** of `## TTS` verbatim: everything from the engine/G2P internals down (the `en-*`/`ru-*`/`macos-*` model details, Kokoro/Vosk ONNX I/O shapes, AVSpeech CFRunLoop notes, SSML parsing internals, the `KESHA_*` env-var list, dev/build env lines, and the Silero/Piper pivot note).

- [ ] **Step 2: Replace `## TTS` body in `CLAUDE.md` with a short user-facing summary + pointer.** Keep inline:

  ```markdown
  ## TTS

  Text-to-speech via three engines selected by voice id prefix:
  `en-*` → Kokoro-82M (24 kHz), `ru-*` → Vosk-TTS (22.05 kHz), `macos-*` → AVSpeech sidecar.
  Install Kokoro + Vosk with `kesha install --tts` (~990 MB); `macos-*` needs no download.
  Models are never auto-downloaded — `kesha say` fails loudly with a `kesha install --tts` hint.
  Default voices MUST be male (see the male-voice rule above). `kesha say` writes WAV to stdout
  unless `--out`; stderr is progress only.

  **Engine internals, ONNX I/O shapes, G2P split, SSML handling, env vars, dev/build setup:**
  `docs/runbooks/tts-internals.md`.
  ```

  (The "DEFAULT TTS VOICES MUST BE MALE" section under Critical Development Rules is **not** touched.)

- [ ] **Step 3: Verify.**
  ```bash
  cd .worktrees/slim-claudemd
  for s in "510x256" "resolve_vosk_ru" "CFRunLoopRun" "KESHA_MODEL_MIRROR" "byt5-tiny" "DYLD_FALLBACK_LIBRARY_PATH"; do
    printf '%-26s runbook=%s claude=%s\n' "$s" \
      "$(grep -c -F "$s" docs/runbooks/tts-internals.md)" "$(grep -c -F "$s" CLAUDE.md)"
  done
  ```
  Expected: each `runbook=1+`, `claude=0`.

- [ ] **Step 4: Commit**
  ```bash
  cd .worktrees/slim-claudemd
  git add docs/runbooks/tts-internals.md CLAUDE.md
  git commit -m "docs: extract TTS internals runbook from CLAUDE.md"
  ```

---

### Task 4: Extract the jj + Git LFS runbook

**Files:**
- Create: `docs/runbooks/jj-git-lfs.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create `docs/runbooks/jj-git-lfs.md`** with header (trigger: "using jj in this repo, or jj shows LFS files as modified") + the entire `### JJ + GIT LFS WORKAROUND` section verbatim.

- [ ] **Step 2: Replace the section in `CLAUDE.md` with a stub:**

  ```markdown
  ### JJ + GIT LFS WORKAROUND

  This repo uses Git LFS; stock `jj` surfaces LFS files as modified. Use the LFS fork
  (`gusinacio/jj` `lfs` branch) + `jj config set --user git.ignore-files '["lfs"]'`.

  **Full setup + operational lessons:** `docs/runbooks/jj-git-lfs.md`.
  ```

- [ ] **Step 3: Verify.**
  ```bash
  cd .worktrees/slim-claudemd
  grep -c -F "gusinacio" docs/runbooks/jj-git-lfs.md   # expect 1+
  grep -c -F "brew unlink jj" CLAUDE.md                # expect 0
  ```

- [ ] **Step 4: Commit**
  ```bash
  cd .worktrees/slim-claudemd
  git add docs/runbooks/jj-git-lfs.md CLAUDE.md
  git commit -m "docs: extract jj+Git LFS runbook from CLAUDE.md"
  ```

---

### Task 5: Extract the OpenClaw plugin runbook

**Files:**
- Create: `docs/runbooks/openclaw-plugin.md`
- Modify: `CLAUDE.md`

Sections to move verbatim: `### OPENCLAW PLUGIN` and `### PUBLISHING THE OPENCLAW PLUGIN TO CLAWHUB`.

- [ ] **Step 1: Create `docs/runbooks/openclaw-plugin.md`** with header (trigger: "editing the OpenClaw plugin or publishing it to ClawHub") + both sections verbatim (`## ` headings).

- [ ] **Step 2: Replace both sections in `CLAUDE.md` with one stub:**

  ```markdown
  ### OPENCLAW PLUGIN

  Plugin lives in `openclaw.plugin.json` + `openclaw-plugin.cjs`. Audio transcription routes
  through the `type: "cli"` path (NOT `registerMediaUnderstandingProvider`). The `dangerous-exec`
  scanner is a naive regex — never name forbidden module substrings, even in comments.

  **Internals, scanner rules, recommended config, ClawHub publish:** `docs/runbooks/openclaw-plugin.md`.
  ```

- [ ] **Step 3: Verify.**
  ```bash
  cd .worktrees/slim-claudemd
  grep -c -F "dangerous-exec" docs/runbooks/openclaw-plugin.md   # expect 1+
  grep -c -F "ClawHub" docs/runbooks/openclaw-plugin.md          # expect 1+
  grep -c -F "registerMediaUnderstandingProvider" CLAUDE.md      # expect 1 (the stub mention only)
  ```

- [ ] **Step 4: Commit**
  ```bash
  cd .worktrees/slim-claudemd
  git add docs/runbooks/openclaw-plugin.md CLAUDE.md
  git commit -m "docs: extract OpenClaw plugin runbook from CLAUDE.md"
  ```

---

### Task 6: Trim in-place sections, final-verify, open PR

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Shorten `### MODEL HASHES ARE PINNED`.** Keep the rule + the bump-command block, but replace the prose tail with a skill pointer:

  ```markdown
  ### MODEL HASHES ARE PINNED — UPSTREAM BUMPS GO THROUGH A PR

  Every entry in `rust/src/models.rs` carries a pinned SHA-256; `download_verified` refuses a
  mismatched file. Never comment out verification to "get it working" (the #174 regression).
  To bump a model version, use the `verify-pin-bump` skill — it walks the safe procedure
  (verify the new upstream weights deliberately, then update the pin + `cargo test models::manifest_tests`).
  ```

- [ ] **Step 2: Trim the `## Project Structure` tree** to load-bearing paths only: keep `bin/`, the `src/*.ts` list, the `rust/src/` tree (main/audio/models/lang_id/text_lang + `backend/`), `tests/`, and the workflow files; drop inline path comments longer than ~6 words. Keep it a valid tree.

- [ ] **Step 3: Final size + dangling-link check.**
  ```bash
  cd .worktrees/slim-claudemd
  wc -c CLAUDE.md                      # expect < 40000, target ~26000
  # every runbook pointer resolves to a real file:
  for f in $(grep -oE 'docs/runbooks/[a-z-]+\.md' CLAUDE.md | sort -u); do
    test -f "$f" && echo "OK $f" || echo "MISSING $f"
  done
  ```
  Expected: size under 40k; every line `OK`.

- [ ] **Step 4: Repo pre-push sanity (no code changed, but the rule applies).**
  ```bash
  cd .worktrees/slim-claudemd
  bun test && bunx tsc --noEmit
  ```
  Expected: green. (If LFS/test fixtures aren't materialized in the worktree, note it; this is docs-only.)

- [ ] **Step 5: Commit + push + open PR.**
  ```bash
  cd .worktrees/slim-claudemd
  git add CLAUDE.md
  git commit -m "docs: trim model-hash + project-structure sections inline"
  git push -u origin chore/slim-claudemd
  gh pr create --base main --head chore/slim-claudemd \
    --title "docs: slim CLAUDE.md below the 40k always-loaded threshold" \
    --body "Moves task-triggered runbooks to docs/runbooks/*, leaving the hard rules + pointers inline. ~53.7k → ~26k chars, content preserved verbatim. Spec: docs/superpowers/specs/2026-05-31-slim-claudemd-design.md"
  ```

- [ ] **Step 6: Wait for CI + Greptile, address P1/P2, merge after the latest head SHA is green and reviewed** (per the repo's Greptile-gate rule).

---

## Self-Review

**Spec coverage:** release.md (Task 1), rust-gotchas.md (Task 2), tts-internals.md (Task 3), jj-git-lfs.md (Task 4), openclaw-plugin.md (Task 5), MODEL HASHES shorten + Project Structure trim + size verification (Task 6). All "stays inline" sections are listed in the do-not-touch block. ✔ every spec section maps to a task.

**Placeholder scan:** No TBD/TODO. Pointer-stub wording is given concretely; the moved content is referenced by exact heading rather than re-pasted (it already exists in CLAUDE.md — re-pasting 50k chars here would be the failure mode, not the fix). ✔

**Type consistency:** Runbook filenames are identical across the File Structure table, every task's create-path, every pointer stub, and the Task 6 dangling-link check (`release.md`, `rust-gotchas.md`, `tts-internals.md`, `jj-git-lfs.md`, `openclaw-plugin.md`). ✔
