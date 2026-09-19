# Nix Install

Alternative reproducible-build path for Kesha Voice Kit. The Bun install (`bun add -g @drakulavich/kesha-voice-kit`) remains the canonical install — npm publish + the `kesha-engine` binaries from GitHub Releases are what CI gates against. The Nix flake is a parallel artifact for users who already live in Nix.

**Prerequisites:** [Nix](https://nixos.org/download/) with flakes enabled. Supported systems: `aarch64-darwin`, `x86_64-linux`.

> **Status:** only the engine derivation (`.#kesha-engine`) builds today. The full `kesha` CLI (`.#kesha`, `nix run`, `nix profile install`) is **not yet available** — see [The `kesha` CLI is not yet buildable via Nix](#the-kesha-cli-is-not-yet-buildable-via-nix) below. Until that is resolved, install the CLI with `bun add -g @drakulavich/kesha-voice-kit`.

## Engine only (no Bun, no Node)

For users who just want the Rust binary — this is the supported Nix path:
```bash
nix build github:drakulavich/kesha-voice-kit#kesha-engine
./result/bin/kesha-engine --help
./result/bin/kesha-engine describe   # protocol schema: backend, profile, features
```

## Development shell
```bash
nix develop github:drakulavich/kesha-voice-kit
# Now you have: pinned rustc/cargo (via rust-overlay), bun, protoc, cmake, pkg-config, libclang
```

## The `kesha` CLI is not yet buildable via Nix

The flake defines `packages.kesha` / `apps.default` (the Bun CLI wired to the flake-built engine), but they **cannot build as committed**. The CLI's Bun dependency closure is a fixed-output derivation whose `outputHash` is a placeholder (`lib.fakeHash`), so `nix run` / `nix build .#kesha` / `nix profile install` all fail with a hash-mismatch error every time until a maintainer with Nix populates the real value:

```bash
nix build .#kesha 2>&1 | grep -A1 'hash mismatch'   # read the `got:` value
# then paste it into keshaNodeModules.outputHash in flake.nix and rebuild
```

That is a maintainer workflow, not a user one — and it re-breaks whenever `bun.lock` changes, with nothing in CI to catch it (the flake is deliberately not a CI gate). Re-enabling the CLI Nix path (populating the hash, or adopting `bun2nix` so no fixed hash is needed, then re-documenting `nix run` here) is tracked in [#946](https://github.com/drakulavich/kesha-voice-kit/issues/946). Until then, use the Bun install:

```bash
bun add -g @drakulavich/kesha-voice-kit
kesha install       # downloads models (~2.5 GB, speech-to-text only)
kesha audio.ogg     # transcript to stdout
```

## Why Nix?

- Reproducible builds across Linux/macOS
- All native deps (onnxruntime, protobuf, abseil) handled automatically
- No "works on my machine" — same `flake.nix` = identical results everywhere
