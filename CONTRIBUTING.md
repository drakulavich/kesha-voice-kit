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
independently — see [`CLAUDE.md`](./CLAUDE.md) "RELEASE PROCESS" for the
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
bun run check       # typecheck + version drift + deterministic CLI tests (the fast path)
just test           # bun unit + integration tests
bun run lint        # bunx tsc --noEmit
just smoke-test     # bun link → kesha install → run against fixtures
just release        # lint + test + smoke-test
```

**Keep the fast path sacred.** `bun run check` (and `bun run test:cli-fast`)
must stay free of engine downloads, model installs, and heavy e2e. Use it for
every CLI-only change. Engine-backed integration, TTS e2e, diarization, and
smoke tests live on the slower explicit path (`just test`, `just smoke-test`,
CI). Do not pull network or multi-GB dependencies into the fast loop.

Use `bun run check` for a quick local confidence pass before
opening small CLI-only PRs. It avoids the engine-backed E2E lanes while still
covering command routing, stdout/stderr contracts, help goldens, and wrapper
validation.

Rust engine work happens in `rust/`:

```bash
cd rust
cargo test --no-default-features --features onnx,tts --lib
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
│   ├── rust-test.yml           # PR touching rust/: cargo test/fmt/clippy across 3 OSes
│   └── build-engine.yml        # tag push (v*, excluding -cli): build 3 binaries + draft release
├── raycast/                    # Raycast extension (separate npm tree, vendored)
├── openclaw.plugin.json        # OpenClaw manifest
├── openclaw-plugin.cjs         # OpenClaw entry
└── package.json                # @drakulavich/kesha-voice-kit
```

## Pull requests

- Branch from `main`. Don't pile unrelated changes into one PR.
- Run `just test && bun run lint` before pushing. For Rust changes, also `cd
  rust && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test`.
- CI must pass before merging. `main` is protected.
- Squash-merge preferred. Greptile reviews are advisory but their P1/P2
  findings should be addressed before merge.
- For active work, tag the issue with the `WIP` label so the maintainer
  sees it at a glance:
  ```bash
  gh issue edit <N> -R drakulavich/kesha-voice-kit --add-label WIP
  ```

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
- Integration tests in `tests/integration/` — exercise the actual engine
  binary, run on macos-14 in CI. Prefer these the moment behaviour crosses the
  CLI or engine boundary.
- Rust integration tests in `rust/tests/` — `cargo nextest` / `just rust-test`
  (matches CI). Do not rely on plain `cargo test` for the suite.
- `audio-quality-check` agent runs after every commit touching
  `rust/src/tts/**` (see `.claude/agents/audio-quality-check.md`).

### Fast path vs slow path

| Path | Command | What it is for |
|------|---------|----------------|
| **Fast (sacred)** | `bun run check` / `bun run test:cli-fast` | Design feedback while coding. No engine download, no models, no network. Must stay seconds-fast. |
| **Full local** | `just test` | Unit + integration (still avoids the heaviest model-dependent e2e). |
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
just mutants-ts src/voice-routing.ts          # TypeScript (Stryker + Bun)
just mutants-ts src/engine.ts src/cli/main.ts # several files
just mutants-ts --with-integration src/foo.ts # include integration suites (slower)

just mutants-rust src/errors.rs               # Rust (cargo-mutants; needs clean tree)
```

Or via npm scripts: `bun run mutants:ts -- src/voice-routing.ts`.

Treat survivors on critical paths (engine spawn, capability checks, install
hints, stdout/stderr contracts, voice routing) as real design debt. Leave
equivalent or intentionally untestable mutants alone; the goal is stronger
assertions, not 100% kill rate. Details and quality bar live in
[`CLAUDE.md`](./CLAUDE.md) under "TESTS COME FIRST, AND ARE JUDGED BY WHAT THEY CATCH".

Handy loops:

- `bun run test:watch` — re-run tests on save during development.
- `bun test -t "<pattern>"` — run only tests whose name matches `<pattern>`
  (e.g. `bun test -t "say"`).

## CI workflows

- `ci.yml` — runs on PRs: `changes` filter → unit-tests (3 OSes) +
  integration-tests + tts-e2e + raycast-lint + pr-comment.
  `integration-tests` is skipped on `release/*` branches (release
  chicken-and-egg: pinned engine tag doesn't exist yet).
- `rust-test.yml` — runs on PRs touching `rust/**`: `cargo test/fmt/clippy`
  on 3 OSes + `cargo check --features coreml --no-default-features` on
  macos-14.
- `build-engine.yml` — runs on `v*` tag pushes (excluding `v*-cli`):
  builds 3 platform binaries, smoke-tests each with `--capabilities-json`,
  creates a draft release.
- No inline scripts > 3 lines — extract to `.github/scripts/`.

## Releases

The full release runbook lives in [`CLAUDE.md`](./CLAUDE.md) "RELEASE
PROCESS". Quick orientation:

- **Engine release** (any change under `rust/`, or bumping
  `keshaEngine.version`): bump `rust/Cargo.toml` + `rust/Cargo.lock` +
  `package.json#version` + `package.json#keshaEngine.version` in lockstep
  on a `release/X.Y.Z` branch → merge → tag `vX.Y.Z` → write release notes
  on the **draft** release before publishing → independent validation
  (download the binary, run end-to-end) → `npm publish --access public`.

- **CLI-only patch** (docs, TS fix, plugin tweak): bump only
  `package.json#version` → merge → `npm publish` → tag `vX.Y.Z-cli` (the
  `-cli` suffix excludes the tag from `build-engine.yml` so no Rust
  rebuild fires).

Tag names are one-shot — GitHub's immutable releases permanently reserve
them after publish. Broken release → bump patch and cut a new tag. Never
tag "just to test"; use `gh workflow run "🔨 Build Engine" --ref main`.

## License

By contributing, you agree that your contributions will be licensed under
the MIT License (see [`LICENSE`](./LICENSE)).
