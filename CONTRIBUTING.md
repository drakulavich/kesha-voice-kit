# Contributing

Thanks for your interest in `@drakulavich/kesha-voice-kit`!

## Setup

```bash
git clone https://github.com/drakulavich/kesha-voice-kit.git
cd kesha-voice-kit
just dev-setup           # checks toolchains/system deps, runs safe local setup
```

`just dev-setup` is the one-command bootstrap: it auto-runs the safe,
project-local steps (`bun install`, `bun link`, and installs `cargo-nextest`)
and **checks** for the system dependencies the Rust build needs (`protoc`,
`libopus` + `pkg-config`, `libclang` on Linux), printing
the exact per-OS install command for anything missing. It never runs
`brew`/`sudo apt-get` on your behalf, and it's safe to re-run. The manual
equivalent:

```bash
bun install
bun link
kesha install            # downloads the engine binary + ASR / lang-id models
kesha install --tts      # opt-in: Kokoro + Vosk-TTS (~990 MB)
kesha install --vad      # opt-in: Silero VAD model
```

The CLI is a Bun/TypeScript wrapper around `kesha-engine`, a Rust binary
downloaded from GitHub Releases. One version, `package.json#version`, names
both; a published CLI carries the engine it installs, with each Engine or
Sidecar asset's SHA-256 and size, as `package.json#kesha.engine`, injected at publish.

### Trying another engine release

The pin is injected at publish and never committed, and `bun run
check:versions` refuses one in the repository. To exercise one release
without touching version control:

```bash
kesha install --engine-version 1.24.8-alpha.1            # exact version, no floating "latest"
kesha install --engine-version 1.24.8-alpha.1 --tts en   # one-shot: keeps the override for this install
kesha doctor                                             # names the installed version and the pin
kesha install                                            # back to the pin
```

The flag applies to the invocation that names it and nothing else. **Any later
install without it reinstalls the pin over the engine you were testing** —
including an additive one like `kesha install --tts en`, which is the most
likely surprise. A version with no published release fails naming the tag it
looked for; it never falls back to the pin. `kesha install --plan
--engine-version …` previews the same install and downloads nothing.

This is a developer tool for trying an engine, not a release channel: nothing
resolves "the newest alpha", and the CLI's own prerelease channel is separate
(the `alpha` npm dist-tag, `bun add -g @drakulavich/kesha-voice-kit@alpha`).
`kesha init` deliberately has no such flag — it is the guided first-run path.

New here? [`docs/architecture.md`](./docs/architecture.md) is the code-level
map — repo layout, the CLI↔engine boundary, ASR/TTS backends, model pinning,
where tests live, and a "where to change X" table.

## Development

```bash
bun run check       # tsc + versions + recipes + test:cli-fast (the fast path; needs just)
just test           # bun unit + integration tests
bun run lint        # bunx tsc --noEmit
just smoke-test     # bun link → kesha install → run against fixtures
just release        # check (lint + versions + recipes + all Bun tests) + smoke-test
```

**Keep the fast path sacred.** `bun run check` (and `bun run test:cli-fast`)
must stay free of engine downloads, model installs, and heavy e2e. Use it for
every CLI-only change. Real-engine e2e, TTS e2e, diarization, and smoke tests
are not on this path: `just test` runs unit plus `tests/integration/` (real-
engine cases self-skip, on two different gates — see
`tests/integration/README.md`), `just smoke-test`
is the explicit install-and-fixtures path, and TTS e2e / diarization live in
CI. Do not pull network or multi-GB dependencies into the fast loop.

Use `bun run check` for a quick local confidence pass before
opening small CLI-only PRs. It avoids the engine-backed E2E lanes while still
covering command routing, stdout/stderr contracts, help goldens, and wrapper
validation.

Rust engine work happens in `rust/`:

```bash
cd rust
cargo nextest run --lib
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

These build the default `portable` profile (`onnx,tts`), which is what the
Linux and Windows releases ship. The darwin-arm64 release ships the `darwin`
profile; lint it on Apple Silicon with Xcode Command Line Tools installed via
`just verify-darwin-full`, which the macOS Rust lane of `ci.yml` also runs.

## Project structure

```
kesha-voice-kit/
├── bin/kesha.js                # shebang entry
├── src/                        # Bun/TypeScript CLI + library
│   ├── cli.ts                  # citty argument parsing, --format, install/transcribe/status
│   ├── lib.ts                  # public API at @drakulavich/kesha-voice-kit/core
│   ├── engine.ts               # subprocess wrapper, capability cache, IPC types
│   ├── engine-install.ts       # engine binary download, verified against the injected pin
│   ├── transcribe.ts           # thin forwarder to the engine; segments shape
│   ├── synth.ts                # TTS forwarder
│   ├── status.ts               # `kesha status` (cache disk usage)
│   └── log.ts                  # KESHA_DEBUG-aware logger
├── rust/                       # kesha-engine Rust binary
│   ├── Cargo.toml              # `onnx` (default) / `coreml` / `tts` / `system_tts` features
│   ├── build.rs                # Swift rpath under `coreml`; AVSpeech sidecar bake-in
│   ├── src/
│   │   ├── main.rs             # clap: transcribe / detect-lang / say / install / ...
│   │   ├── cli/transcribe.rs   # `transcribe` subcommand entry
│   │   ├── transcribe/         # ASR pipeline + VAD routing + timestamped segments
│   │   ├── audio.rs            # symphonia decode + rubato resample
│   │   ├── lang_id.rs          # ONNX speechbrain audio language detection
│   │   ├── text_lang.rs        # macOS NLLanguageRecognizer (macOS only)
│   │   ├── vad.rs              # Silero VAD v5 (576-sample rolling context)
│   │   ├── capabilities.rs     # feature list `describe` serves
│   │   ├── tts/                # Kokoro + Vosk + AVSpeech + SSML
│   │   │   ├── kokoro.rs       # ONNX Kokoro-82M
│   │   │   ├── vosk.rs         # vosk-tts-rs wrapper
│   │   │   ├── avspeech.rs     # macOS AVSpeechSynthesizer Swift sidecar
│   │   │   ├── ssml/           # ssml-parser → Segment { Text, Spell, Emphasis, Break, Ipa }
│   │   │   ├── en/             # English acronym auto-expansion (#244)
│   │   │   ├── ru/             # Russian acronym auto-expansion (#232)
│   │   │   └── encode.rs       # WAV / OGG-Opus / FLAC encoder
│   │   ├── say_loop.rs         # `--stdin-loop` warm session for batch TTS
│   │   └── backend/            # transcribe backend trait + onnx + fluidaudio
│   └── tests/                  # cargo integration tests (warm --stdin-loop harness)
├── tests/{unit,integration}/   # bun:test
├── scripts/                    # benchmark.ts, smoke-test.ts
├── .github/workflows/
│   ├── ci.yml                  # PR: unit + integration + tts-e2e + type check, and the Rust lanes (🧪 Rust Tests)
│   └── release.yml             # every release: build, smoke and publish (stable tag, beta/alpha)
├── raycast/                    # Raycast extension (separate npm tree, vendored)
├── openclaw.plugin.json        # OpenClaw manifest
├── openclaw-plugin.cjs         # OpenClaw entry
└── package.json                # @drakulavich/kesha-voice-kit
```

## Pull requests

- Branch from `main`. Don't pile unrelated changes into one PR.
- Run `just test && bun run lint` before pushing. For Rust changes, also `just
  rust-test` and `cd rust && cargo fmt && cargo clippy --all-targets -- -D warnings`.
  Do not use plain `cargo test` for the suite.
- CI must pass before merging. `main` is protected.
- Squash-merge preferred. Greptile P1/P2 findings are merge blockers; gate on
  the findings, not on its confidence score.
- Active work is visible as a branch, a worktree, and an open PR — there is
  no label to apply.

## Code style

- TypeScript strict mode, ESNext target, Bun runs `.ts` directly.
- Bun-native APIs (`Bun.spawn`, `Bun.write`, `Bun.file`) — no Node `child_process`.
- `console.error()` for progress + errors (stderr stays diagnostic);
  `console.log()` / `process.stdout.write()` for piped output.
- Relative imports (`./engine`, not `src/engine`).
- Rust: `cargo fmt` + `cargo clippy --all-targets -- -D warnings` are
  CI-fatal. Don't suppress lints with `#[allow(dead_code)]` — see
  [`CLAUDE.md`](./CLAUDE.md) "NO SPECULATIVE FIELDS OR ENUM VARIANTS".

## Error handling

- Human-readable messages: what failed, why, what to do.
- Never swallow errors silently. Never return success on failure.
- For TTS / ASR install errors, use the bordered ASCII install hint (see
  `src/transcribe.ts` for the canonical shape).

## Tests

- Unit tests in `tests/unit/` — no external deps, run on
  Linux/Windows/macOS. Prefer these for pure functions and deterministic CLI
  contracts.
- Integration tests in `tests/integration/` — most drive a fake engine and run
  everywhere; real-engine suites self-skip, and not on one condition —
  `e2e-engine` and `mcp-e2e` gate on an installed engine, while `say-e2e` and
  `mcp-synthesis-e2e` gate on a source-built `rust/target/release/kesha-engine`
  plus the committed Kokoro stand-in, so installing an engine does not run them.
  `tests/integration/README.md` states the convention and
  `tests/unit/model-suite-guards.test.ts` enforces it. CI's fast
  `integration-tests` job is macos-latest and does not install an engine. Prefer
  these the moment behaviour crosses the CLI or engine boundary.
- Rust integration tests in `rust/tests/` — `cargo nextest run` / `just rust-test`
  (matches CI). Do not rely on plain `cargo test` for the suite.

### Fast path vs slow path

| Path | Command | What it is for |
|------|---------|----------------|
| **Fast (sacred)** | `bun run check` / `bun run test:cli-fast` | Design feedback while coding. No engine download, no models, no network. Keep it that way; do not confuse it with `just check`, which runs all integration tests. |
| **Full local** | `just test` | Unit + `tests/integration/`. Fake-engine suites always run; real-engine e2e runs only where its own gate is satisfied — `kesha install` covers `e2e-engine`/`mcp-e2e`, not the synthesis suites. This recipe never downloads the 2.4 GB bundle. |
| **Smoke / release** | `just smoke-test`, `just release` | Real install + fixtures. Explicit and slower. |
| **CI** | `ci.yml` | Authoritative gates; model-heavy jobs are path-filtered or self-skipping. |

Do not add engine installs, large fixtures, or network calls to the fast path.
If a change needs those, put the test on the slower path and keep the fast
loop pure.

### Mutation testing

Coverage tells you code was *executed*. Mutation testing tells you whether the
tests would *notice* if behaviour changed. A surviving mutant is a missing
assertion, not a score to inflate.

The one sanctioned tool is `just mutate`: name the guard, name the mutation,
name the test, and it proves the pair in seconds. It runs the test once on the
untouched file and demands green, applies the mutation, restores the file, and
exits 0 only when the mutation was caught:

```bash
just mutate src/voice-routing.ts "!code || confidence < 0.5" "!code || confidence < 0" bun test tests/unit/voice-routing.test.ts
just mutate rust/src/errors.rs "<find>" "<replace>" cargo nextest run --manifest-path rust/Cargo.toml --all-targets -E "test(errors)"
```

Exit codes: 0 PINNED, 1 NOT PINNED, 2 usage or refusal (needle absent, or
occurring more or fewer times than `--occurrences N` says — it is an exact
count, not a ceiling — or a sidecar left behind), 3 NOT A VALID RUN (baseline
red, timeout — `--timeout S`, default 600 s, or `MUTATE_TIMEOUT_SECONDS` —
interrupted, or a command that could not start). A timeout, `SIGINT` or
`SIGTERM` restores the file itself; only a run killed outright leaves
`<file>.mutate-orig` beside the mutated file, and the next run refuses
until you restore it yourself with `mv <file>.mutate-orig <file>`. Record the
rows in the PR the way `docs/mutation-evidence/` does when a review asks for
proof.

The whole-file lanes (`mutants-ts` on Stryker, `mutants-rust` on
cargo-mutants) were retired in #1212 and #1213: the TypeScript verdicts
were not reproducible between runs and a whole-file run cost up to 30 minutes,
and the Rust lane yielded little on a crate already at 96.8% while `--in-place`
left an interrupted mutation in the working tree looking like an ordinary edit.
The survivor classes they taught remain the triage rule: the argv synthesised
for the engine subprocess (retired as a contract in #163), TTY write cadence and
code unreachable by construction are correct to leave alive. Treat survivors on
critical paths (engine spawn, capability checks, install hints, stdout/stderr
contracts, voice routing) as real design debt. The behavioural,
structure-insensitive test quality bar is in [`CLAUDE.md`](./CLAUDE.md) under
"TESTS COME FIRST, AND ARE JUDGED BY WHAT THEY CATCH".

Handy loops:

- `bun run test:watch` — re-run tests on save during development.
- `bun test -t "<pattern>"` — run only tests whose name matches `<pattern>`
  (e.g. `bun test -t "say"`).

## CI workflows

- `ci.yml` — runs on PRs: `changes` filter → unit-tests (3 OSes) +
  `integration-tests` (macos-latest, no engine install) + path-filtered
  `integration-tests-full`, `tts-e2e`, and `raycast-lint`. The full
  integration and TTS jobs skip `release/*`; `integration-tests` does not.
- `ci.yml`'s Rust lanes (`🧪 Rust Tests`) — run on PRs touching `rust/**`: nextest plus fmt/clippy,
  and macos-14 also runs the CoreML `cargo check --all-targets` and
  `just verify-darwin-full` feature set.
- `release.yml` — the only workflow that publishes. A stable `vX.Y.Z` tag,
  a dispatched beta or alpha, or a merge to `main` labelled `alpha` builds,
  smokes and publishes; a PR that touches it runs the same jobs as a
  rehearsal and publishes nothing.
- No inline scripts > 3 lines — extract to `.github/scripts/`.

## Releases

One version names the CLI and the engine, and `release.yml` publishes both.
The procedure is the `release` skill (`.claude/skills/release/SKILL.md`), and
[docs/distribution.md](docs/distribution.md) covers the channels and install
paths. In short: `main` carries the next version; a maintainer cuts a stable
release with `just release-tag vX.Y.Z notes.md`, and the run publishes the
GitHub release, npm (with provenance), the Homebrew tap and the Docker image.
**Do not publish from a laptop**: that loses the provenance attestation.

Tag names are one-shot, because GitHub's immutable releases reserve them after
publish. A broken release is fixed by the next patch. Never tag to test; a PR
that touches `release.yml` runs a rehearsal.

## License

By contributing, you agree that your contributions will be licensed under
the MIT License (see [`LICENSE`](./LICENSE)).
