# Contributing

Thanks for your interest in parakeet-cli!

## Setup

```bash
git clone https://github.com/drakulavich/parakeet-cli.git
cd parakeet-cli
bun install
bun link
parakeet install
```

## Development

```bash
make test           # unit + integration tests
make lint           # type check
make smoke-test     # link + install + run against fixtures
make release        # lint + test + smoke-test
```

## Project Structure

```
src/                  # TypeScript source
  cli.ts              # CLI entry point
  lib.ts              # Public API
  transcribe.ts       # Backend selection (CoreML → ONNX)
  coreml.ts           # CoreML detection + subprocess
  models.ts           # Model download + cache
  audio.ts            # ffmpeg audio conversion
  preprocess.ts       # Mel-spectrogram (nemo128.onnx)
  encoder.ts          # FastConformer encoder
  decoder.ts          # RNN-T decoder + beam search
  tokenizer.ts        # Vocab + detokenization
tests/integration/    # E2E tests (require backend + ffmpeg)
src/__tests__/        # Unit tests
scripts/              # Benchmark + smoke test (TypeScript)
.github/scripts/      # CI helper scripts (TypeScript)
swift/                # CoreML Swift binary (built by CI)
```

## Pull Requests

- Create a feature branch from `main`
- One PR per change — don't pile unrelated changes
- Run `make test && make lint` before pushing
- CI must pass before merging
- Squash merge preferred

## Code Style

- TypeScript strict mode, ESNext target
- Bun-native APIs (`Bun.spawn`, `Bun.write`, `Bun.file`) — no Node.js APIs
- Use `.slice()` not `.subarray()` for ONNX tensors
- `console.error()` for progress/errors, `process.stdout.write()` for results
- Relative imports (`./models`, not `src/models`)

## Error Handling

- Every error must be human-readable: what failed, why, what to do
- Never swallow errors silently
- Use the Playwright-style error box for user-facing install errors

## Tests

- Unit tests in `src/__tests__/` — no external deps, run on all platforms
- Integration tests in `tests/integration/` — require backend + ffmpeg, run on macOS CI
- Add tests for new code

## CI Workflows

- `ci.yml` — runs on PRs: unit tests (Linux/Windows/macOS) + integration tests (macOS)
- `benchmark.yml` — runs on release: faster-whisper vs parakeet on Ubuntu
- `build-coreml.yml` — runs on release: builds Swift binary, attaches to GitHub release
- CI scripts must be TypeScript (`.github/scripts/*.ts`)
- Workflow steps: max 3 lines of bash, extract longer logic to scripts

## Releases

1. Bump version in `package.json`
2. `make release` — verify everything passes
3. Create GitHub release
4. `npm publish --access public`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
