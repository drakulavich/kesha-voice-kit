---
paths:
  - ".github/**"
  - "rust/build.rs"
  - "rust/Cargo.toml"
---

# CI workflows and the engine build

## COREML BUILD

The `coreml` feature links the macOS Swift runtime via `fluidaudio-rs`. The runner, Xcode and deployment-target requirements sit on the `darwin` profile in `rust/Cargo.toml`. `rust/build.rs` emits `-Wl,-rpath,/usr/lib/swift` under `cfg(any(coreml, system_kokoro, system_diarize))` — narrowing that to `coreml` alone breaks local `system_kokoro`/`system_diarize` builds.

`release.yml`'s `build` job smoke-tests every binary with `describe` before upload, and `darwin-synthesis-smoke` and `roundtrip-smoke` synthesise with the built artifacts before anything is published. **Never remove those steps** (`requirePreUploadSynthesisSmoke`).

Every `build` row names exactly one Cargo profile, `portable` or `darwin`, and `check-workflows.ts` fails any other value (`requireReleaseRowsNameOneProfile`); a feature every release needs goes into both profiles in `rust/Cargo.toml`, never into a row.

## RELEASES

`release.yml` is the only workflow that publishes. A pull request that touches it runs a rehearsal: every build and smoke, no publish. Only jobs gated on `plan.publish` hold `contents: write` or `id-token: write` (`requireReleaseJobOrder`), and the run is never cancelled mid-flight (`requireReleaseQueue`). Never dispatch it to "try something": a dispatch publishes. How to cut a release: the `release` skill.

## WORKFLOW `run:` SHELL INJECTION — USE ENV PASSTHROUGH

GHA `${{ inputs.X }}` / `${{ github.event.* }}` expressions are substituted into `run:` **before** the shell sees them, so a value containing `$(cmd)`, `;`, or a newline executes. Severity scales with job permissions: anything holding `id-token: write` (npm provenance) can leak the OIDC token. Route every user-controlled expression through `env:` first, then reference it as a normal shell variable (#291):

```yaml
env:
  INPUT_TAG: ${{ inputs.tag }}
run: echo "tag=$INPUT_TAG" >> "$GITHUB_OUTPUT"
```

`bun run check:workflows` enforces this and the 3-line cap on `run:` (`forbidExpressionsInRun`, `forbidLongInlineRun`) over workflows and composite actions: any `${{` in the parsed `run:` scalar fails, shell comments included, while `if:`, `with:`, `env:` and `name:` are free. Lines count as a reader sees them, blanks and `#` comments excluded. A step that must stay inline (it runs before checkout, or from a historical `inputs.ref`) folds to three lines rather than taking an exemption.
