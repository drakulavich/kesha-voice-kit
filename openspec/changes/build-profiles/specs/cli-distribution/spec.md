## MODIFIED Requirements

### Requirement: The Nix flake is an alternate build path, and never a release gate

The Nix flake SHALL define a from-source Engine build for `aarch64-darwin` and `x86_64-linux` from the `portable` profile, adding `system_tts` on darwin so the AVSpeech Sidecar is exercised, and MAY define the CLI pointed at the Engine the same flake built. Only the Engine derivation (`.#kesha-engine`) SHALL be presented as a usable Nix path; the CLI derivation (`.#kesha`) SHALL NOT be documented as a working install method while its dependency derivation's output hash is an unpopulated placeholder. No published artifact SHALL depend on the flake, so a flake that does not build blocks nothing.

#### Scenario: Maks builds the Engine through Nix

- GIVEN Maks has Nix with flakes enabled on Apple Silicon
- WHEN Maks runs `nix build .#kesha-engine`
- THEN the Engine is built from source from the `portable` profile, carrying the
  Pinned Engine version in a file beside the binary
- AND the `say-avspeech` Sidecar is present beside it

#### Scenario: The CLI Nix path is not presented as an install method

- GIVEN the CLI's dependency derivation carries a placeholder output hash that
  no one has populated, so `nix run` / `nix build .#kesha` fail with a hash
  mismatch
- WHEN a user reads the README or `docs/nix-install.md`
- THEN no doc presents `nix run` / `nix profile install .#kesha` as a working
  install method — the only documented Nix path is `nix build .#kesha-engine`
- AND the flake still exposes `.#kesha`, so a maintainer with Nix can populate
  the hash (or adopt `bun2nix`) and re-document the CLI path
- AND no release lane fails as a result

> *Technical Note — `flake.nix` exposes `packages.kesha` and
> `packages.kesha-engine`; `kesha-engine` is built with naersk and records
> `package.json#keshaEngine.version` into `bin/kesha-engine.version`
> (`flake.nix::kesha-engine`), and the `kesha` wrapper sets `KESHA_ENGINE_BIN`
> to it (`flake.nix::kesha`). `rustFeatures` in `flake.nix` is `portable,system_tts` on
> darwin-arm64 and `portable` elsewhere; the comment above it records why the
> flake cannot build the `darwin` profile (SwiftPM clones offline). `flake.nix::keshaNodeModules` has
> `outputHash = lib.fakeHash`, and the comment above it states
> plainly that `packages.default`, `apps.default`, and any `nix run` /
> `nix profile install .#kesha` invocation fail until it is populated — so the
> docs (README "Other install methods", `docs/nix-install.md`) present only
> `nix build .#kesha-engine` as usable and mark the CLI path as not yet
> available (#946). CLAUDE.md states the flake is not a CI gate; `nix-build` in
> `ci.yml` builds `.#kesha-engine` only, on push.*
