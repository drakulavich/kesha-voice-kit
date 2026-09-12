---
paths:
  - ".github/**"
  - "rust/build.rs"
  - "rust/Cargo.toml"
---

# CI workflows and the engine build

## COREML BUILD TRIPLE

The `coreml` feature links the macOS Swift runtime via `fluidaudio-rs`. All three must hold:

1. `macos-14` runner + `maxim-lobanov/setup-xcode@v1` pinned to `16.2`
2. `MACOSX_DEPLOYMENT_TARGET=14.0`, so the linker elides `@rpath/libswift_Concurrency.dylib`
3. `rust/build.rs` emits `-Wl,-rpath,/usr/lib/swift` under `cfg(any(coreml, system_kokoro, system_diarize))` — narrowing that to `coreml` alone breaks local `system_kokoro`/`system_diarize` builds

`build-engine.yml` smoke-tests every binary with `describe` before upload. **Never remove that step.**

## BUILD-ENGINE FEATURE MATRIX MIRRORS CARGO DEFAULTS

`build-engine.yml` passes `--features <matrix> --no-default-features` per platform. Adding a feature to cargo's default set **also requires adding it to every matrix row**, or released binaries silently ship without it (v1.1.0 shipped without `tts`). Check before a release:

```bash
grep -E '^\s+features:' .github/workflows/build-engine.yml   # every matrix row
grep '^default =' rust/Cargo.toml                            # cargo's default set
```

Every **additive** default (today `tts`) must appear in every row. The ASR backends are mutually exclusive on purpose: `onnx` is a default yet must never appear on the CoreML row, and vice versa.

## WORKFLOW `run:` SHELL INJECTION — USE ENV PASSTHROUGH

GHA `${{ inputs.X }}` / `${{ github.event.* }}` expressions are substituted into `run:` **before** the shell sees them, so a value containing `$(cmd)`, `;`, or a newline executes. Severity scales with job permissions: anything holding `id-token: write` (npm provenance) can leak the OIDC token. Route every user-controlled expression through `env:` first, then reference it as a normal shell variable (#291):

```yaml
env:
  INPUT_TAG: ${{ inputs.tag }}
run: echo "tag=$INPUT_TAG" >> "$GITHUB_OUTPUT"
```
