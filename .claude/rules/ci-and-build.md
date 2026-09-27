---
paths:
  - ".github/**"
  - "rust/build.rs"
  - "rust/Cargo.toml"
---

# CI workflows and the engine build

## COREML BUILD

The `coreml` feature links the macOS Swift runtime via `fluidaudio-rs`. The runner, Xcode and deployment-target requirements sit on the `darwin` profile in `rust/Cargo.toml`. `rust/build.rs` emits `-Wl,-rpath,/usr/lib/swift` under `cfg(any(coreml, system_kokoro, system_diarize))` — narrowing that to `coreml` alone breaks local `system_kokoro`/`system_diarize` builds.

`build-engine.yml` smoke-tests every binary with `describe` before upload. **Never remove that step.**

Every `build-engine.yml` release row names exactly one Cargo profile, `portable` or `darwin`, and `check-workflows.ts` fails any other value; a feature every release needs goes into both profiles in `rust/Cargo.toml`, never into a row.

## WORKFLOW `run:` SHELL INJECTION — USE ENV PASSTHROUGH

GHA `${{ inputs.X }}` / `${{ github.event.* }}` expressions are substituted into `run:` **before** the shell sees them, so a value containing `$(cmd)`, `;`, or a newline executes. Severity scales with job permissions: anything holding `id-token: write` (npm provenance) can leak the OIDC token. Route every user-controlled expression through `env:` first, then reference it as a normal shell variable (#291):

```yaml
env:
  INPUT_TAG: ${{ inputs.tag }}
run: echo "tag=$INPUT_TAG" >> "$GITHUB_OUTPUT"
```

`bun run check:workflows` enforces this and the 3-line cap on `run:` (`forbidExpressionsInRun`, `forbidLongInlineRun`) over workflows and composite actions: any `${{` in the parsed `run:` scalar fails, shell comments included, while `if:`, `with:`, `env:` and `name:` are free. Lines count as a reader sees them, blanks and `#` comments excluded. A step that must stay inline (it runs before checkout, or from a historical `inputs.ref`) folds to three lines rather than taking an exemption.
