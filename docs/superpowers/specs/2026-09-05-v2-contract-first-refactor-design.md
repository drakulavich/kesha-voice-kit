# Contract-first v2 refactor — design

**Date:** 2026-09-05
**Status:** draft, awaiting maintainer review
**Goal metric:** agent context budget — fewer files to read for a typical change, fewer "gotcha" rules in `CLAUDE.md`, less churn in CI plumbing.

## 1. Context and evidence

Measured on `main` at `b86313f` (2026-09-05). Commands to reproduce are in the appendix.

| Layer | Size | Signal |
|---|---|---|
| Rust engine | ~28k lines, ~9k of them inline `#[cfg(test)]` | 405 `cfg` attributes over 20 distinct predicates; 7 cargo features encode exactly 2 build profiles |
| TS CLI | ~10.5k lines in 66 files | `cli/main.ts` 645 lines; the install/engine cluster is 10 files and ~2.5k lines; `engine.ts` has 19 importers |
| CI + scripts | 23 workflows (4.3k lines), 60 scripts in `.github/scripts` across `.ts`, `.mjs` + 12 `.d.mts`, `.sh`, `.py` (5.3k lines) | `ci.yml` 51 commits, `rust-test.yml` 45, `check-workflows.ts` 28 in the last 90 days; its test file is the single hottest file in the repo |
| Tests | 26k lines; 104 TS test files for 66 source files | `tests/unit` is the top churn module |
| Docs and process | `CLAUDE.md` 231 lines / 19 rule sections; 10 skills (1.6k lines); openspec specs; decision log; runbooks | seven documents restate the nextest/preflight procedure |

Defect concentration over the last six months (repowise `defect_profile`): `engine-install.ts` 15 fixes, `engine.ts` 12, `cli/main.ts` 12, `transcribe/mod.rs` 9, `tts/say.rs` 8, `doctor.ts` 7. The first four are also the top churn files, and `cli/main.ts` and `transcribe/mod.rs` carry a test gap.

Release machinery alone is ~1.9k script lines, ~1.6k workflow lines and ~2.2k test lines, because the CLI (1.29.1) and the engine (1.24.11) are versioned and tagged independently: bare `vX.Y.Z`, `-cli` marker, `-alpha.N`, `-beta.N`, draft plus a manual un-draft gate, and a post-release job that bumps the CLI's engine pin. Since mid-May there were 15 engine releases, 13 CLI-only releases and 10 pre-releases; the two often ship on the same day. An engine build takes about 9 minutes and produces ~60 MB per platform; a CLI-only release takes about 2 minutes.

Two things the tooling reported that turned out to be wrong, recorded so nobody re-investigates them:

- repowise reports a 25-file import cycle in `src/`. A Tarjan SCC over the real relative imports finds zero cycles; the artefact comes from treating `package.json#bin -> src/cli.ts` as an edge while `src/package-info.ts` imports `package.json`. The only real module cycles are in Rust and are small: `backend <-> transcribe` (three files import `transcribe::WordTiming`) and `models <-> tts` (`manifest.rs` calls `tts::fluid_kokoro::available_voice_ids`).
- repowise flags ~200 "unused internal" symbols. Spot checks show constant tables used inside their own file. Only two files are genuinely dead: `packaging/homebrew/Formula/kesha-voice-kit.rb`'s class symbol (still used by the tap) and `rust/swift/kesha-textlang.swift` (compiled by `build.rs`, not imported). Neither is deleted by this design.

## 2. Decisions already taken

- **Strategy: contract-first (v2).** The maintainer chose to redefine the contracts first and migrate the layers under them, over a periphery-first sequence of small refactors or a delete-only pass. The known cost, a long-lived branch, is avoided by the delivery model in section 4.
- **Contracts may break.** CLI flags, the `/core` API, the CLI<->engine protocol and the tag grammar can change with a major release.
- **Success is measured by agent context budget**, not lines deleted, CI wall time or bus factor. Section 8 lists the numbers.

## 3. Contracts v2

### C1. CLI <-> engine protocol, version 4

Today stdout is mixed (text, JSON, audio bytes), errors are recognised by the regex `^error \[E_CODE\]:` on stderr, progress by the string prefix `diarize: `, the `KESHA_DEBUG` timeline goes to a separately forwarded file descriptor, capabilities and the error taxonomy are two flags, and the TS side keeps its own native codes with a drift test. The CLI parses `protocolVersion` but never gates on it: the unit-test stub still answers `2`.

v4:

- **stdout carries payload only** (transcript text or JSON, audio bytes, WAV path). Everything else the engine says goes to **stderr as NDJSON**, one object per line: `{"kind":"progress"|"warn"|"error"|"debug","code"?:"E_...","message":"...","hint"?:"...",...}`. Human-readable rendering happens in the CLI only. The `KESHA_DEBUG` timeline becomes `kind: "debug"` on the same stream, gated by the same env var; the fd forwarding (`KESHA_DEBUG_FD`, `spawnStdioWithDebugFd`) is removed.
- **`kesha-engine describe`** replaces `--capabilities-json` and `--error-codes-json` with one document: `protocolVersion: 4`, `backend`, `profile` (see C2), every subcommand with its accepted flags and their gates, the error-code taxonomy with category and retryability, TTS languages and engines. The CLI validates argv against this schema with one generic function before spawning; the hand-written `preflight*` / `assert*Supported` family and the "do not blindly forward flags" rule become code.
- **Protocol version is a gate.** A `describe` that reports a version other than 4 is an actionable error naming `kesha install`, never a silent success.
- **`say --stdin-loop`** keeps its stdin framing; its status lines move to the NDJSON stream so no v3 island remains.
- One error class on the TS side, `KeshaError { code, hint }`, for engine-reported and CLI-native failures alike; CLI-native codes (`E_ENGINE_SPAWN`, `E_INPUT_NOT_FOUND`, `E_INVALID_ARG`) join the taxonomy the engine publishes, so the drift test disappears.

Recommended, to decide in stage 0: derive the flag list in `describe` from clap at runtime (`CommandFactory::command()`), keep the gates in a table beside it, and test that the two sets match, so a new flag cannot be forgotten in the schema.

### C2. Two build profiles instead of seven features

`build-engine.yml` always ships darwin with `coreml,tts,system_tts,system_kokoro,system_diarize,system_text_lang` and everything else with `onnx,tts`. Seven features encode two profiles.

v2: `portable` (default: ONNX ASR + TTS, builds anywhere including a Mac without Xcode) and `darwin` (CoreML ASR, native Kokoro, diarization, AVSpeech and the text-language sidecar). The 20 distinct `cfg` predicates collapse into named aliases emitted by `build.rs` (`darwin_native`, `portable`), consumed from one `platform.rs`. `build-engine.yml`, `rust-test.yml` and the `justfile` speak in profiles. `diarize.rs` stops being invisible to the standard verify set because `darwin` is the only Mac profile.

### C3. Public API `/core`, version 2

Remove `downloadCoreML`, `transcribeWithSegments` (alias) and `downloadModel` (which installs the engine). Surface: `transcribe(path, opts) -> TranscribeResult` (always structured; plain text is `.text`), `say(...)`, `install({ engine, tts, vad, diarize, noCache })`, `capabilities()`, `toToon()`, `KeshaError`. `TranscribeResult`'s fields are unchanged. `docs/api.md` is the only place the removed names appear outside `src/` and tests.

### C4. One version, one tag

CLI and engine share `package.json#version`; `rust/Cargo.toml` mirrors it and `bun run check:versions` keeps them equal. A single `vX.Y.Z` tag builds the three engine binaries and sidecars, smoke-tests them, publishes the GitHub release, publishes npm with provenance pinned to the same version, and updates the tap, deb/rpm, Docker and the Nix version file. `-alpha.N` stays as the auto-published pre-release channel and is the carrier for the migration (section 4). The `-cli` marker, `-beta`, draft-plus-un-draft and the post-release pin bump are removed; binary validation moves into the release workflow, before publication, using the just-built assets. The cost: a CLI-only release takes ~9 minutes instead of ~2 and re-uploads ~190 MB.

### C5. Four workflows

- `ci.yml` — the PR gate. The three required check names are kept: `🧪 CI` stays the aggregate job, `🧪 Rust Tests` becomes the name of the Rust aggregate job inside `ci.yml` (today it lives in `rust-test.yml`), and `🛡️ Security Audit` stays in `security.yml`. Branch protection is not touched.
- `nightly.yml` — the six schedule-only workflows (`capability-pact`, `cargo-dependency-maintenance`, `mini-model-pact`, `model-plan-size-canary`, `prune-alpha-releases`, `real-model-canary`) become jobs.
- `release.yml` — C4.
- `security.yml` — unchanged.

`actionlint` is added and takes over pinned actions, shell selection, timeouts and syntax; `check-workflows.ts` keeps only repo-specific invariants (packaging job ordering, pact coverage of every target, cache writers for restore-only caches). Scripts move to one language, TypeScript under bun; the `.mjs` files exist only because release jobs run them with `node`, and the twelve `.d.mts` sidecars exist only for them.

## 4. Delivery without a long-lived branch

Contract-first means spec and pact tests before code, not one branch for everything. Every step below is a PR into `main` through the existing gates. The device that makes this possible is the **engine alpha as the carrier**: the new protocol lands in the engine first, ships as `-alpha.N`, and CLI PRs pin that alpha in `package.json#keshaEngine.version`. The CLI never carries two parsers.

| Stage | Content | PRs | Ends with |
|---|---|---|---|
| 0 | Four openspec changes: `protocol-v4` (C1), `build-profiles` (C2), `core-api-v2` (C3), `unified-release` (C4+C5), each with delta specs to `engine-contract`, `programmatic-api`, `cli-distribution`, `installation`. Pact tests rewritten to v4 and left red. | 1–2 | pact tests written; where they land is open issue 3 |
| 1 | Engine speaks v4: `describe`, NDJSON stderr, `protocolVersion: 4`, `stdin-loop` status on the stream. The old flags and the 84 `eprintln!` calls across 21 files are deleted in the same PRs that replace them. | 3–4 | tag `v1.25.0-alpha.1` |
| 2 | CLI moves to v4. First PR: alpha pin, generic argv validation from `describe`, NDJSON renderer, `KeshaError`; deletes `preflight*`, `assert*Supported`, `isProgressLine`, the stderr regex, `TS_NATIVE_CODES`, the drift test, `KESHA_DEBUG_FD` forwarding. Then one PR each for `transcribe`, `say`, `install`, `record`, MCP. | 5–6 | `integration-tests-full` green on the alpha pin |
| 3 | Build profiles (C2), in parallel with 1–2: `Cargo.toml`, cfg aliases via `build.rs`, `platform.rs`, `build-engine.yml` matrix, `rust-test.yml`, `justfile`. Lands before `describe` so the schema reports `profile`. | 2–3 | both profiles green in CI |
| 4 | `core-api-v2` (one PR: `lib.ts`, `synth.ts`, `docs/api.md`). Then `unified-release`: `release.yml`, `nightly.yml`, deletion of the 12 release-shaped workflows and ~20 release scripts with their tests, one workflow per deletion PR, `actionlint`, distribution channels re-pointed to one version with a smoke per channel. | 8–12 | tag `v2.0.0`, which publishes CLI 2.0.0 pinned to itself; CHANGELOG "Breaking" section |
| 5 | Layers under the stable contract (section 5): `src/engine/`, `src/install/`, `cli/transcribe/`, `diagnostics/`, `transcribe/{backend,policy,chunking,vad_path,pipeline}`, inline tests moved out, `CLAUDE.md` shrunk. One module per PR. | 10–15 | metrics in section 8 re-measured |

Rules for the migration window (first alpha tag to `v2.0.0`):

- No CLI release. `bun add -g` users stay on 1.29.x + 1.24.x and notice nothing.
- No feature work merges except through the new contract.
- Hard cap: three weeks from the first alpha tag. If exceeded, the fallback is a CLI that carries both protocols temporarily so it can release again; that fallback is a deliberate decision recorded in the decision log, not a drift.
- Every PR carries a claim for the adversarial review, for example for stage 2: "the CLI on the alpha pin passes `cli-contracts` with no legacy path left; if false, the grep test asserting no `error \[` literal in `src/` fires."

## 5. Target structure

Principle: a directory is a boundary an agent can read whole. Each has one entry point and answers "what it does, how to call it, what it depends on" without reading its neighbours.

### TypeScript, `src/` (66 files -> ~45)

```
src/
  engine/         everything that talks to the subprocess (today engine.ts 697 + synth.ts 231 + parts of transcribe.ts)
    spawn.ts        Bun.spawn, process tree, abort
    describe.ts     v4 schema cache + the one generic argv validation
    events.ts       NDJSON stderr -> progress/warn/error/debug; KeshaError { code, hint }
    transcribe.ts   say.ts   record.ts   lang.ts
  install/        plan -> execute -> verify (today 10 files, ~2.5k lines, three defect magnets)
    components.ts   Component model: engine, asr, tts-pack, vad, diarize, sidecar
                    (absorbs engine-targets, kokoro-ane, fluid-roots, fluid-asr-cache, cache-layout)
    plan.ts         execute.ts (download, verify, lock, version marker)   health.ts
  cli/
    transcribe/     args.ts   languages.ts   output.ts   command.ts   (today main.ts, 645 lines)
    say.ts install.ts init.ts record.ts status.ts doctor.ts stats.ts logs.ts mcp.ts support-bundle.ts completions.ts manpage.ts
    dispatch.ts context.ts command-session.ts
  diagnostics/    doctor.ts status.ts support-bundle.ts diagnostic-log.ts diagnostic-paths.ts diagnostic-events.ts
  mcp/            unchanged
  stats.ts        untouched (2 commits in 90 days; not a liability)
  lib.ts          public API v2;  cli-entry.ts;  types.ts format.ts toon.ts log.ts paths.ts error-utils.ts
```

Deleted: the `src/cli.ts` re-export shim (tests import real modules), `preflight*` / `assert*Supported`, `error-codes.ts` and its drift test, `isProgressLine`, `install-hint.ts` (its seven importers take the hint from `KeshaError`), the stray `src/__tests__/` directory (its cases move under `tests/unit/`). `engine` goes from 19 importers to `cli/*`, `install/`, `mcp/`, `lib.ts`.

### Rust, `rust/src/` (shape kept; three changes)

```
rust/src/
  protocol/       NEW: events.rs (one NDJSON emitter replacing 84 eprintln! calls in 21 files),
                  describe.rs (commands, flags, gates, codes, tts languages), errors.rs (moved here)
  transcribe/
    types.rs      WordTiming, TranscriptionSegment, TranscriptionOutput
    backend/      moved from the crate root: mod.rs onnx.rs fluidaudio.rs (the backend<->transcribe cycle disappears)
    policy.rs     VadMode, decide, validate_plain_transcribe_safety, vad_mode_for_diarization
    chunking.rs   fixed_chunk_windows, seam_*, transcribe_chunked*
    vad_path.rs   transcribe_via_vad, build_vad_output_segments
    pipeline.rs   transcribe_with_options as five named steps
    diarize.rs itn.rs options.rs
    tests/        inline tests move to files (1386 lines leave mod.rs)
  models/         download.rs: 1415 test lines -> tests.rs; available_voice_ids moves to manifest (the models<->tts cycle disappears)
  platform.rs     the only home of the cfg aliases: darwin_native / portable
  tts/ audio.rs vad.rs record.rs streaming_asr.rs lang_id.rs text_lang.rs   unchanged
```

`transcribe/` is not renamed to `asr/`: a rename touches every path in docs, tests and `CLAUDE.md` for no structural gain.

What it buys on the goal metric: a "new transcribe flag" change today reads `main.rs`, `transcribe/mod.rs`, `capabilities.rs`, `engine.ts` (preflight), `transcribe.ts`, `cli/main.ts`, `cli-contracts.test.ts` and the openspec delta — eight files plus a `CLAUDE.md` rule. After: `cli/transcribe.rs`, `protocol/describe.rs`, `cli/transcribe/args.ts` and a test — four, with validation coming from the schema.

## 6. Tests, gates, coverage

**Contract tests are the spine.** Stage 0 rewrites the pact tests to v4 and leaves them red: Rust `transcribe_schema_pact`, `error_codes_cli`, `public_api_paths`; TS `capabilities-pact`, `transcribe-schema-pact`, `error-codes-cli`, `cli-contracts`. Three are added: `describe-schema-pact` (the TS parser against the Rust emitter on one shared JSON fixture), `protocol-events` (NDJSON line shape, including CRLF normalisation for Windows), and the protocol-version gate (a stub answering `protocolVersion: 3` must produce an actionable error, not run). `tests/helpers/fake-engine.ts` becomes the single stub: answers `describe`, writes NDJSON.

**Unit tests follow the structure.** `tests/unit/` mirrors the `src/` directories. The install cluster's 17 files (3.1k lines) consolidate into four by contract (`components`, `plan`, `execute`, `health`); `engine.test.ts` (909 lines) splits with `engine/`. Tests of `preflight*`, argv order and `TS_NATIVE_CODES` are deleted; schema validation gets one property test, "any flag outside the schema is rejected before spawn". Release-shaped tests (~2.2k lines) leave with their scripts; the new `release.yml` keeps one tag-grammar test. Rust: inline test modules over 300 lines move to a sibling `tests.rs` as a pure move; e2e suites and model gates are untouched.

**Gates.** The three required check names stay. `just preflight` keeps the TS gate as is; the Rust gate becomes "`portable` always, `darwin` on macOS", replacing the separate `cargo check --features coreml` and `verify-darwin-full` pair. `preflight-parity.test.ts` keeps the justfile equal to `ci.yml`. Greptile and the adversarial review are unchanged.

**Coverage.** Floors move from files to directories: `engine/**` 80, `install/**` 60, `cli/transcribe/**` 35, `cli/say.ts` 50; `check-coverage.ts` gains glob matching. The 70% totals for TS and Rust are unchanged.

## 7. Documentation

- `CLAUDE.md`: 19 sections -> ~11. Removed because they became code: "DO NOT BLINDLY FORWARD CLI FLAGS" (schema validation), "BUILD-ENGINE FEATURE MATRIX MIRRORS CARGO DEFAULTS" (profiles), "COREML BUILD TRIPLE" (becomes a comment on the `darwin` profile in `Cargo.toml` / `build.rs`), the darwin caveat in "VERIFY BEFORE PUSHING", and the Releases section shrinks to one paragraph. Kept: male default voices, never auto-download, bun-only, venv, worktrees, tests first, PR etiquette, Greptile, adversarial review, error handling, no speculative fields, pinned model hashes, spikes, shell injection, prompt injection.
- Skills: `release-engine` + `release-cli` + `release-mechanics` (543 lines) -> one `release` skill (~120 lines). `verify-pin-bump`, `tts-internals` and the openspec skills are unchanged.
- `docs/`: `architecture.md` is rewritten to the new map; `decision-log.md` gains one entry per contract (C1–C5); `release-manifest.md`, `homebrew.md`, `linux-packages.md` and `nix-install.md` merge into `distribution.md`; `errors.md` is generated from `describe` by a script, replacing the `error_codes_docs.rs` drift test. `rust-gotchas.md` stays.
- Stage-5 rule: every PR deletes at least one line of `CLAUDE.md` or says why it cannot.

## 8. Success metrics

Measured at the end of stage 5, baseline from section 1.

| Metric | Now | Target |
|---|---|---|
| Files read for "new transcribe flag" | 8 + a `CLAUDE.md` rule | 4 |
| `CLAUDE.md` | 231 lines, 19 rules | ≤130, ≤11 |
| Workflows / scripts | 23 / 60 in four languages | 4 / ≤25 in TypeScript (+ sh where unavoidable) |
| Commits into CI plumbing per 90 days | 124 | <30 at the next measurement |
| Files in `src/`, largest file | 66, 1205 lines | ~45, ≤400 (except `stats.ts`) |
| Distinct `cfg` predicates in Rust | 20 | ≤6 |
| Inline test lines in one file | 1415 | ≤300 |
| Fixes per 6 months in the four defect magnets | 15 / 12 / 12 / 9 | re-measure 6 months after `v2.0.0` |

## 9. Risks

- **The no-release window stretches.** Hard cap of three weeks from the first alpha tag; past it, the CLI temporarily carries both protocols so it can release, as a recorded decision.
- **NDJSON on stderr for anyone running `kesha-engine` by hand.** The only external trace is an example in `docs/nix-install.md`; Rust tests that read stderr are updated in stage 1. No "human" output flag is added: `kesha` is the human interface.
- **One version makes an engine hotfix a CLI release too.** Accepted; one CHANGELOG stream.
- **Windows.** The NDJSON parser normalises CRLF; `protocol-events` covers it. Windows CI checks out with CRLF, so fixtures are read with normalisation.
- **Distribution after the single tag.** `homebrew-tap.yml`, the formula, deb/rpm, Docker and `flake.nix` know two versions today; stage 4 re-points them in one PR with a smoke per channel.
- **Large deletion PRs.** One workflow per PR so Greptile and the adversarial review have something to examine.
- **Greptile inline findings go stale across force-pushes**; the review restarts on the new head as `CLAUDE.md` already requires.

## 10. Non-goals

Rewriting the ONNX backend (worst health score, but stable churn and three fixes), TTS internals (G2P, SSML, normalisation), `models/manifest` logic, Raycast, OpenClaw and Hermes integrations, the MCP tool surface, `stats.ts`, performance work, Nix beyond the version file.

## 11. Open issues, with recommendations

1. **`describe` schema source.** Recommended: flags derived from clap at runtime, gates in a table beside them, a test that the sets match. Decide in stage 0.
2. **`KESHA_DEBUG_FD`.** C1 folds it into `kind: "debug"` on the NDJSON stream and deletes the fd forwarding. Confirm in stage 0 that `doctor.ts` and the support bundle need nothing the stream cannot carry.
3. **Red pact tests on `main` during stage 0.** Either land them behind an explicit `skip-until: stage-1` marker that `model-suite-guards` recognises, or land them in the first stage-1 PR. Recommended: the first stage-1 PR, so `main` never carries a skipped test.

## Appendix: reproducing the baseline

```bash
find src -name '*.ts' | xargs wc -l | sort -rn | head           # TS sizes
find rust/src -name '*.rs' | xargs wc -l | sort -rn | head      # Rust sizes
grep -rhoE '#\[cfg\([^]]+\)\]' rust/src | sort | uniq -c        # cfg predicates
cat .github/workflows/*.yml | wc -l; ls .github/scripts | wc -l # CI footprint
git log --since='90 days' --name-only --format='' | sort | uniq -c | sort -rn | head -30   # churn
gh release list --limit 40 --json tagName,publishedAt,isPrerelease                          # cadence
grep -c '^### ' CLAUDE.md                                        # rule sections
```

Repowise `get_health` (KPIs, defect profiles) and `get_risk` on the ten hottest files supplied the fix counts and test-gap flags.
