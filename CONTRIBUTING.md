# Contributing

Thanks for your interest in `@drakulavich/kesha-voice-kit`!

## Setup

```bash
git clone https://github.com/drakulavich/kesha-voice-kit.git
cd kesha-voice-kit
just dev-setup           # checks toolchains/system deps, runs safe local setup
```

`just dev-setup` is the one-command bootstrap: it auto-runs the safe,
project-local steps (`bun install`, `bun link`, `git lfs pull`, and installs
`cargo-nextest`) and **checks** for the system dependencies the Rust build needs
(`protoc`, `libopus` + `pkg-config`, `libclang` on Linux, `git-lfs`), printing
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
downloaded from GitHub Releases at the version pinned in
`package.json#keshaEngine.version`. CLI and engine are versioned
independently — see [`CLAUDE.md`](./CLAUDE.md) "Releases" for the
full split.

### Trying an engine build without editing the pin

The pin decides what every CI lane on every unrelated PR and every published
CLI downloads, so committing a throwaway build points all of them at it —
`bun run check:versions` refuses an alpha there outright. To exercise one
release without touching version control:

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
cargo nextest run --no-default-features --features onnx,tts --lib
cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings
cargo fmt --check
```

`coreml` and `system_tts` are macOS-only features — `cargo check
--no-default-features --features coreml,tts,system_tts` runs on the
darwin-arm64 CI job.

## Project structure

```
kesha-voice-kit/
├── bin/kesha.js                # shebang entry (aliased as `parakeet` for legacy)
├── src/                        # Bun/TypeScript CLI + library
│   ├── cli.ts                  # citty argument parsing, --format, install/transcribe/status
│   ├── lib.ts                  # public API at @drakulavich/kesha-voice-kit/core
│   ├── engine.ts               # subprocess wrapper, capability cache, IPC types
│   ├── engine-install.ts       # engine binary download (uses keshaEngine.version)
│   ├── transcribe.ts           # thin forwarder to the engine; segments shape
│   ├── say.ts                  # TTS forwarder
│   ├── status.ts               # `kesha status` (cache disk usage)
│   └── log.ts                  # KESHA_DEBUG-aware logger
├── rust/                       # kesha-engine Rust binary
│   ├── Cargo.toml              # `onnx` (default) / `coreml` / `tts` / `system_tts` features
│   ├── build.rs                # Swift rpath under `coreml`; AVSpeech sidecar bake-in
│   ├── src/
│   │   ├── main.rs             # clap: transcribe / detect-lang / say / install / ...
│   │   ├── transcribe.rs       # ASR pipeline + VAD routing + timestamped segments
│   │   ├── audio.rs            # symphonia decode + rubato resample
│   │   ├── lang_id.rs          # ONNX speechbrain audio language detection
│   │   ├── text_lang.rs        # macOS NLLanguageRecognizer (macOS only)
│   │   ├── vad.rs              # Silero VAD v5 (576-sample rolling context)
│   │   ├── capabilities.rs     # `--capabilities-json` feature list
│   │   ├── tts/                # Kokoro + Vosk + AVSpeech + SSML
│   │   │   ├── kokoro.rs       # ONNX Kokoro-82M
│   │   │   ├── vosk.rs         # vosk-tts-rs wrapper
│   │   │   ├── avspeech.rs     # macOS AVSpeechSynthesizer Swift sidecar
│   │   │   ├── ssml.rs         # ssml-parser → Segment { Text, Spell, Emphasis, Break, Ipa }
│   │   │   ├── en/             # English acronym auto-expansion (#244)
│   │   │   ├── ru/             # Russian acronym auto-expansion (#232)
│   │   │   └── encode.rs       # WAV / OGG-Opus / MP3 encoder
│   │   ├── say_loop.rs         # `--stdin-loop` warm session for batch TTS
│   │   └── backend/            # transcribe backend trait + onnx + fluidaudio
│   └── tests/                  # cargo integration tests (warm --stdin-loop harness)
├── tests/{unit,integration}/   # bun:test
├── scripts/                    # benchmark.ts, smoke-test.ts
├── .github/workflows/
│   ├── ci.yml                  # PR: unit + integration + tts-e2e + type check
│   ├── rust-test.yml           # PR touching rust/: nextest/fmt/clippy across 3 OSes
│   └── build-engine.yml        # tag push (v*, excluding -cli): build 3 binaries + draft release
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
- Squash-merge preferred. Greptile reviews are advisory but their P1/P2
  findings should be addressed before merge.
- Active work is visible as a branch, a worktree, and an open PR — there is
  no label to apply. See [`docs/runbooks/conveyor.md`](docs/runbooks/conveyor.md)
  for the loop.

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
- `audio-quality-check` agent runs after every commit touching
  `rust/src/tts/**` (see `.claude/agents/audio-quality-check.md`).

### Fast path vs slow path

| Path | Command | What it is for |
|------|---------|----------------|
| **Fast (sacred)** | `bun run check` / `bun run test:cli-fast` | Design feedback while coding. No engine download, no models, no network. Keep it that way; do not confuse it with `just check`, which runs all integration tests. |
| **Full local** | `just test` | Unit + `tests/integration/`. Fake-engine suites always run; real-engine e2e runs only where its own gate is satisfied — `kesha install` covers `e2e-engine`/`mcp-e2e`, not the synthesis suites. This recipe never downloads the 2.4 GB bundle. |
| **Smoke / release** | `just smoke-test`, `just release` | Real install + fixtures. Explicit and slower. |
| **CI** | `ci.yml`, `rust-test.yml` | Authoritative gates; model-heavy jobs are path-filtered or self-skipping. |

Do not add engine installs, large fixtures, or network calls to the fast path.
If a change needs those, put the test on the slower path and keep the fast
loop pure.

### Mutation testing

Coverage tells you code was *executed*. Mutation testing tells you whether the
tests would *notice* if behaviour changed. A surviving mutant is a missing
assertion, not a score to inflate.

Scoped runs stay usable because they only re-run the suites that reach the
mutated file:

```bash
just mutants-ts src/voice-routing.ts                           # TypeScript (Stryker + Bun)
just mutants-ts --with-integration src/engine.ts src/cli/main.ts # several files
just mutants-ts --with-integration src/foo.ts # include integration suites (slower)

just mutants-ts .github/scripts/check-workflows.ts             # the CI gates are mutable too
just mutants-ts .github/scripts/npm-dist-tag.mjs               # so is the .mjs release path

just mutants-rust src/errors.rs # Rust: cargo-mutants; clean rust/ tree required
```

Or via npm scripts: `bun run mutants:ts -- src/voice-routing.ts`.

Mutable roots are `src/`, `scripts/` and `.github/scripts/`, in `.ts` or `.mjs`
— the gates enforce the rules in CLAUDE.md and the release path is written in
`.mjs`, so both earn the same measurement (#1091). Selection is by import, so a
suite that only *spawns* a script cannot be found automatically; the run says so
and exits non-zero rather than reporting zero mutants, and it only points at
`--with-integration` when an integration suite would actually reach the source.

The default TypeScript roots are `tests/unit/` only. For engine spawn, CLI
contracts, or install hints, pass `--with-integration` so the relevant
integration suites are measured. `mutants-rust` runs in place: install its tool
once with `cargo install --locked cargo-mutants`, keep `rust/` clean, and
override its default `tts,system_kokoro,system_diarize` features with `just
FEATURES=tts mutants-rust …` when appropriate.

Treat survivors on critical paths (engine spawn, capability checks, install
hints, stdout/stderr contracts, voice routing) as real design debt. Leave
equivalent or intentionally untestable mutants alone; the goal is stronger
assertions, not 100% kill rate. The behavioural, structure-insensitive test
quality bar is in [`CLAUDE.md`](./CLAUDE.md) under "TESTS COME FIRST, AND ARE
JUDGED BY WHAT THEY CATCH"; mutation commands and survivor triage live here.

Handy loops:

- `bun run test:watch` — re-run tests on save during development.
- `bun test -t "<pattern>"` — run only tests whose name matches `<pattern>`
  (e.g. `bun test -t "say"`).

## CI workflows

- `ci.yml` — runs on PRs: `changes` filter → unit-tests (3 OSes) +
  `integration-tests` (macos-latest, no engine install) + path-filtered
  `integration-tests-full`, `tts-e2e`, and `raycast-lint`. The full
  integration and TTS jobs skip `release/*`; `integration-tests` does not.
- `rust-test.yml` — runs on PRs touching `rust/**`: nextest plus fmt/clippy,
  and macos-14 also runs the CoreML `cargo check --all-targets` and
  `just verify-darwin-full` feature set.
- `build-engine.yml` — runs on `v*` tag pushes (excluding `v*-cli`):
  builds 3 platform binaries, smoke-tests each with `--capabilities-json`,
  creates a draft release.
- No inline scripts > 3 lines — extract to `.github/scripts/`.

## Releases

The full release runbook lives in [`CLAUDE.md`](./CLAUDE.md) "Releases".
Quick orientation:

- **Engine release** (any change under `rust/`, or bumping
  `keshaEngine.version`): bump `rust/Cargo.toml` + `rust/Cargo.lock` +
  `package.json#keshaEngine.version` — leave `package.json#version` alone, it
  carries the next unreleased CLI — on a `release/X.Y.Z` branch → merge → tag
  `vX.Y.Z` → write release notes on the **draft** release → validate the draft
  binary with authenticated `gh release download` (draft assets 404 to anonymous
  clients, so `curl` cannot check them) → un-draft. A bare engine tag publishes
  nothing to npm; the bumped pin reaches users with the next `-cli` release.

- **CLI-only patch** (docs, TS fix, plugin tweak): bump `package.json#version`
  and the two `server.json` versions with it, or `bun run check:versions`
  rejects the commit → merge → create the `vX.Y.Z-cli` release. Publishing that
  marker is what runs `npm publish --provenance` in GitHub Actions, and the
  `-cli` suffix excludes the tag from `build-engine.yml` so no Rust rebuild
  fires. **Do not publish from a laptop** — that loses the provenance
  attestation.

Tag names are one-shot — GitHub's immutable releases permanently reserve
them after publish. Broken release → bump patch and cut a new tag. Never
tag "just to test"; use `gh workflow run "🔨 Build Engine" --ref main`.

## License

By contributing, you agree that your contributions will be licensed under
the MIT License (see [`LICENSE`](./LICENSE)).
