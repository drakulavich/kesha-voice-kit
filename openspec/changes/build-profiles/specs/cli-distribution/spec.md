## MODIFIED Requirements

### Requirement: The Nix flake is an alternate build path, and never a release gate

The Nix flake SHALL define a from-source Engine build for `aarch64-darwin` and `x86_64-linux` using the `portable` profile, adding `system_tts` on darwin so the AVSpeech Sidecar is exercised, and MAY define the CLI pointed at the Engine the same flake built. Only the Engine derivation (`.#kesha-engine`) SHALL be presented as a usable Nix path; the CLI derivation (`.#kesha`) SHALL NOT be documented as a working install method while its dependency derivation's output hash is an unpopulated placeholder. No published artifact SHALL depend on the flake, so a flake that does not build blocks nothing.

#### Scenario: Maks builds the Engine through Nix

- GIVEN Maks has Nix with flakes enabled on Apple Silicon
- WHEN Maks runs `nix build .#kesha-engine`
- THEN the Engine is built from source with `profile` reporting `portable`
- AND the `say-avspeech` Sidecar is present beside it

#### Scenario: The CLI Nix path is not presented as an install method

- GIVEN the CLI's dependency derivation carries a placeholder output hash
- WHEN a user reads the README or `docs/nix-install.md`
- THEN no doc presents `nix run` / `nix profile install .#kesha` as a working install method
- AND no release lane fails as a result

> *Technical Note — `rustFeatures` at `flake.nix:59-61` becomes `"portable,system_tts"` on darwin-arm64 and `"portable"` elsewhere; the rationale comment at `flake.nix:47-58` (SwiftPM clone fails offline) stays.*
