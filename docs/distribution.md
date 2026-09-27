# Distribution

Every install path delivers the same `kesha` CLI. None of them downloads the Rust
engine or the models: `kesha install` does that, explicitly, into the Kesha cache
(~2.5 GB for speech-to-text). The canonical path is Bun:

```bash
bun add -g @drakulavich/kesha-voice-kit
kesha install
kesha audio.ogg
```

| Path | Platforms | Where it comes from |
|------|-----------|---------------------|
| [Bun](#bun) | macOS, Linux, Windows | npm, every channel |
| [Homebrew](#homebrew) | macOS, Linux | `drakulavich/tap`, stable releases |
| [Linux packages](#linux-packages) | Linux x64 (glibc) | `.deb` / `.rpm` on stable GitHub releases |
| [Docker](docker.md) | Linux x64 (`amd64`) | GHCR, stable releases and relevant `main` pushes |
| [Nix](#nix) | `aarch64-darwin`, `x86_64-linux` | builds the engine from source; not a release artifact |

## Releases and channels

The CLI and the engine share one version: `package.json#version`, mirrored in
`rust/Cargo.toml`. One workflow, `release.yml`, publishes both:

- **Stable** — a pushed `vX.Y.Z` tag. It builds and smokes the engine on every
  platform, then publishes the GitHub release (engines, Sidecars, Linux packages,
  one `SHA256SUMS`, the [release manifest](#release-manifest) and Sigstore
  bundles), npm under `latest`, the Homebrew tap and the Docker image.
- **Beta** — a dispatched `X.Y.Z-beta.N` that extends `package.json#version`, or a
  pushed `vX.Y.Z-beta.N` tag on a commit whose `package.json#version` is that beta.
  It publishes the engine prerelease and npm under `beta`.
- **Alpha** — a merge to `main` of a PR labelled `alpha` that changes what the
  package ships publishes a CLI `-alpha.N` to npm under `alpha`, against the newest
  stable engine; without the label, a merge publishes nothing. A dispatched
  alpha can pin an engine prerelease instead. Alpha tags record what was
  published; pushing one by hand starts nothing.

A published CLI carries the engine it installs, and each Engine or Sidecar
asset's SHA-256 and size, in `package.json#kesha.engine`. `release.yml` injects it at publish, and it
is never committed. `kesha install` refuses any download that does not match it.

## Bun

`bun add -g @drakulavich/kesha-voice-kit` installs the CLI from npm. Channels:
`@latest` (stable), `@beta`, `@alpha`. The package runs no install-time script.

## Homebrew

The formula installs the Bun-based CLI and depends on Bun from the official tap:

```bash
brew tap oven-sh/bun
brew install drakulavich/tap/kesha-voice-kit
kesha install
```

It installs the TypeScript CLI, its production Bun dependencies and the `kesha`
command. `kesha install` still downloads release assets into the Kesha cache, as
on every other path.

### Maintainer validation

The source formula lives in `packaging/homebrew/Formula/kesha-voice-kit.rb`; the
`homebrew` job of `release.yml` mirrors it into `drakulavich/homebrew-tap` on a
stable release, using the `HOMEBREW_TAP_TOKEN` secret. Its committed
`url`/`sha256` name the real release tarball. CI's `homebrew-formula` lane does
**not** trust that pin: it stages a throwaway tap copy whose `url` is a
`git archive` of HEAD, so the install block is exercised against the checkout
under review (#924). To do the same locally:

```bash
brew tap oven-sh/bun
brew tap-new local/tap
# Audit the committed pin first — --strict rejects the file:// url the stage step
# writes, so it must run before staging, exactly as CI does.
cp packaging/homebrew/Formula/kesha-voice-kit.rb \
  "$(brew --repository local/tap)/Formula/kesha-voice-kit.rb"
brew audit --strict --formula local/tap/kesha-voice-kit
node .github/scripts/stage-homebrew-worktree-formula.mjs \
  --tap-dir "$(brew --repository local/tap)" \
  --archive "$(mktemp -d)/kesha-worktree.tar.gz"
brew install --build-from-source local/tap/kesha-voice-kit
brew test local/tap/kesha-voice-kit
```

The public tap: `brew test drakulavich/tap/kesha-voice-kit` and
`brew audit --strict --formula drakulavich/tap/kesha-voice-kit`.

## Linux packages

`.deb` and `.rpm` ship on every stable release, which publishes the same version
to npm in the same run. Prereleases ship none. Releases before the unified
release scheme attached them to `vX.Y.Z-cli` marker releases instead
([#728](https://github.com/drakulavich/kesha-voice-kit/issues/728)).

The packages install a standalone Bun-compiled `kesha` built for glibc
(`bun-linux-x64`); it does not run on musl distributions such as Alpine — use
the [Docker image](docker.md) there.

```bash
gh release download -R drakulavich/kesha-voice-kit \
  -p 'kesha-voice-kit_*_amd64.deb' -p 'kesha-voice-kit-*.x86_64.rpm' -p SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
sudo apt install ./kesha-voice-kit_*_amd64.deb      # Debian / Ubuntu
sudo dnf install ./kesha-voice-kit-*.x86_64.rpm     # Fedora / RHEL
kesha install
```

Without `gh`, download the assets of the newest stable release from the
[releases page](https://github.com/drakulavich/kesha-voice-kit/releases).

They install `/usr/bin/kesha` and the license, notices and README under
`/usr/share/doc/kesha-voice-kit`, and depend on `ca-certificates` so
`kesha install` can reach release assets and model files over HTTPS.

### What Linux gets

Native packages, Docker and the Nix `x86_64-linux` path share one feature set:

- **Speech-to-text**: ONNX CPU backend (no CoreML/ANE), the same 25 languages as macOS.
- **Text-to-speech**: English, Spanish, French, Italian, Portuguese and Russian
  (`kesha install --tts en es fr it pt ru`). Hindi, Japanese, Chinese and macOS
  system voices are darwin-arm64 only.
- **VAD**: supported (`kesha install --vad`).
- **Speaker diarization**: darwin-arm64 only
  ([#199](https://github.com/drakulavich/kesha-voice-kit/issues/199)).

The full breakdown is the
[platform matrix](product-positioning.md#platform-matrix).

### Maintainer validation

Packaging uses [nFPM](https://nfpm.goreleaser.com/) to emit both formats from one
config:

```bash
.github/scripts/install-nfpm.sh "$HOME/.local/nfpm" && export PATH="$HOME/.local/nfpm:$PATH"
node .github/scripts/build-linux-packages.mjs
.github/scripts/verify-linux-packages.sh
```

The installer fetches the pinned nFPM release binary and refuses it unless its
SHA-256 matches. CI runs the same three commands through
`.github/actions/linux-packages`, from `ci.yml` (on a pull request that touches
packaging, and on `main`) and from `release.yml`'s `packages` job (on a stable
tag, which is what publishes them).

## Nix

An alternate reproducible build for users who already live in Nix. It is not a
release artifact and not a CI gate; the Bun install is what releases are tested
against. Prerequisite: [Nix](https://nixos.org/download/) with flakes enabled.

Only the engine derivation builds today:

```bash
nix build github:drakulavich/kesha-voice-kit#kesha-engine
./result/bin/kesha-engine describe   # protocol schema: backend, profile, features
nix develop github:drakulavich/kesha-voice-kit   # pinned rustc/cargo, bun, protoc, cmake
```

The flake also defines `packages.kesha` (the CLI wired to the flake-built
engine), but it **cannot build as committed**: its Bun dependency closure is a
fixed-output derivation whose `outputHash` is a placeholder (`lib.fakeHash`), so
`nix run`, `nix build .#kesha` and `nix profile install` fail with a hash
mismatch. Populating it (or adopting `bun2nix`) is tracked in
[#946](https://github.com/drakulavich/kesha-voice-kit/issues/946); until then,
install the CLI with Bun.

The flake builds the engine from the `portable` profile (plus `system_tts` on
darwin, for the AVSpeech Sidecar), so it has no speaker diarization:
`kesha install --diarize` refuses and points at the Bun install.

## Release manifest

`kesha-release-manifest.json` ships with every release that builds the engine. It
is a small, stable JSON contract for package-manager channels and records:

- the repository, release tag, CLI version and engine version
- the released engine binaries and macOS Sidecars
- the install layout `kesha install` uses
- the supported platform status
- the checksum and Sigstore bundle naming conventions

It accepts `vX.Y.Z`, `vX.Y.Z-beta.N` and `vX.Y.Z-alpha.N` and rejects anything
else. `engineVersion` comes from the tag: an alpha ships a version no commit
carries (#738). `SHA256SUMS` and the Sigstore bundles cover the manifest itself,
so downstream packaging can verify it before use.

After changing release asset names, the install layout or release packaging, run:

```bash
bun run check:release-manifest
```

It fails when the manifest drifts from `src/engine-targets.ts` or
`.github/workflows/release.yml`.
