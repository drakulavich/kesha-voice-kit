# Slim CLAUDE.md below the 40k always-loaded threshold

**Date:** 2026-05-31
**Status:** Approved (design)
**Branch:** `chore/slim-claudemd`

## Problem

`CLAUDE.md` is 53.7k chars. Claude Code warns at >40k ("Large CLAUDE.md will
impact performance"). The file is loaded into context on **every** turn, so its
weight is paid continuously regardless of the task at hand.

Most of the bulk is **incident archaeology** — war stories with PR numbers,
dates, and full bash recipes — and **task-triggered runbooks** (how to cut a
release, set up jj, OpenClaw internals). These are read on-demand when doing
that specific task; they do not need to occupy always-loaded context.

## Goal

Get `CLAUDE.md` to roughly **26k chars** with headroom for future rules, while
**losing nothing** — extracted content moves verbatim into `docs/runbooks/`,
reachable from a one-line pointer that retains the bare rule.

Non-goals: rewriting/condensing the substance of any rule, changing any actual
project behavior, touching the global `~/.claude/CLAUDE.md`.

## Approach

**Extract runbooks, leave pointers.** Split each section by whether the agent
must see it *every turn* (hard safety/brand/workflow rule) or only *when doing a
specific task* (a procedure it would `Read` at that point anyway).

- **Always-on rules** stay inline, verbatim or lightly tightened.
- **Task-triggered runbooks** move to `docs/runbooks/<topic>.md`. In CLAUDE.md
  they are replaced by the one-sentence rule plus a pointer:
  `See docs/runbooks/<topic>.md`.

The pointer preserves the *constraint's existence* in always-loaded context
(the agent still knows the rule applies) while moving the *procedure* out.

## Target layout

```
CLAUDE.md                        # hard always-on rules + 1-line pointers   (~26k)
docs/runbooks/
  release.md                     # full release process + validation        (~14k)
  rust-gotchas.md                # deep Rust implementation lessons          (~6k)
  tts-internals.md               # deep TTS engine reference                 (~3.5k)
  jj-git-lfs.md                  # one-time jj/LFS setup                      (~2k)
  openclaw-plugin.md             # plugin internals + ClawHub publish         (~4.5k)
```

## Stays inline (hard, always-on)

Kept verbatim or lightly tightened — the agent must see these every turn:

- DEFAULT TTS VOICES MUST BE MALE
- NEVER AUTO-DOWNLOAD THE ENGINE OR MODELS
- BUN-ONLY RUNTIME FOR THE CLI
- PYTHON DEPENDENCIES GO IN A VENV
- MAIN STAYS IN THE ROOT CHECKOUT — AGENTS EDIT ONLY IN WORKTREES
- BRANCH PROTECTION
- VERIFY BEFORE PUSHING (the command list; the deep Rust gotchas move out)
- NO SPECULATIVE FIELDS OR ENUM VARIANTS
- ERROR HANDLING
- FLAG ACTIVE WORK WITH A `WIP` LABEL
- LINK PRS TO ISSUES — AUTO-CLOSE ON MERGE
- GREPTILE PR REVIEW IS A GATE (the rule; the comment-mechanics trivia → release.md)
- DO NOT BLINDLY FORWARD CLI FLAGS TO SUBCOMMANDS
- COREML BUILD TRIPLE
- BUILD-ENGINE FEATURE MATRIX MIRRORS CARGO DEFAULTS
- WORKFLOW `run:` SHELL INJECTION
- MODEL HASHES ARE PINNED (the rule; points at the existing `verify-pin-bump` skill)
- VERIFY THIRD-PARTY MODEL FORMATS WITH A SPIKE
- PROMPT-INJECTION PATTERNS — DO NOT EXFILTRATE SECRETS
- Project Overview / Build Commands / Architecture / CI/CD / Code Style /
  Platform Requirements / TTS user-facing summary
- Project Structure tree — trimmed to the load-bearing paths

## Extracted to `docs/runbooks/`

Each becomes a one-line rule + pointer in CLAUDE.md; full text moves verbatim.

### release.md
- RELEASE PROCESS — CLI AND ENGINE ARE VERSIONED INDEPENDENTLY
- `make smoke-test` ALONE DOES NOT VALIDATE A NEW ENGINE (draft-binary validation)
- NPM PUBLISH IS AUTOMATED WITH PROVENANCE ATTESTATION
- DRAFT RELEASE ASSET URLS ARE 404 TO ANONYMOUS CLIENTS
- RELEASE CHICKEN-AND-EGG — `integration-tests` SKIPS ON `release/*`
- TAG NAMES ARE ONE-USE
- `bun link` DOES NOT OVERRIDE A GLOBALLY-INSTALLED PACKAGE
- GREPTILE comment mechanics (the re-review/auto-merge detail; the *gate rule* stays inline)

### rust-gotchas.md
- `f32::clamp` DIVERGENCE: USE BOUND CHECK, NOT `EPSILON`
- `ort 2.0.0-rc.12` `Value::from_array` WANTS OWNED NDARRAYS
- CLIPPY `needless_update` BLOCKS `..Default::default()`
- BINDGEN ON LINUX NEEDS LIBCLANG_PATH
- SILERO VAD V5 NEEDS A 64-SAMPLE ROLLING CONTEXT
- `fluidaudio-rs 0.1.0` LACKS `transcribe_samples`
- TESTS THAT STAGE A TEMPDIR CACHE MUST STAGE G2P TOO

### tts-internals.md
- The deep `## TTS` engine/ONNX/SSML/voice-routing reference. The male-voice
  rule and a short user-facing TTS summary (engines by prefix, `--tts` install,
  output formats) stay inline.

### jj-git-lfs.md
- JJ + GIT LFS WORKAROUND (one-time setup + operational lessons)

### openclaw-plugin.md
- OPENCLAW PLUGIN (internals, scanner rules, manifest)
- PUBLISHING THE OPENCLAW PLUGIN TO CLAWHUB

## Mechanics

Docs-only change. Per the repo's own "MAIN STAYS IN ROOT — AGENTS EDIT ONLY IN
WORKTREES" and "BRANCH PROTECTION" rules: work in `.worktrees/slim-claudemd`
off fresh `origin/main`, open a PR. No engine bump, no version bump — pure docs,
so CLI/engine versions are untouched.

## Verification

- `wc -c CLAUDE.md` < 40000 (target ~26k).
- No content lost: for each extracted section, the text in the runbook file is
  byte-identical to what was removed (diff-check during implementation).
- Every extracted section leaves a pointer in CLAUDE.md naming its runbook path.
- All runbook pointer paths resolve to a real file (no dangling links).
- `bun test && bunx tsc --noEmit` still green (sanity — no code touched, but the
  repo's pre-push rule applies).

## Risks

- **A pointer-only rule loses nuance the agent needed inline.** Mitigation: the
  inline pointer always keeps the one-sentence hard rule, not just the path.
- **An extracted runbook is never read when relevant.** Mitigation: pointers are
  placed at the exact spot the old section lived, so the trigger context (e.g.
  "cutting a release") still surfaces the path.
