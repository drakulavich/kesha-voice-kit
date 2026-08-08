# Linux Packages

> **Where to find them.** `.deb` and `.rpm` are attached to **CLI releases** —
> the marker releases tagged `vX.Y.Z-cli` — because the package *is* the CLI.
> They used to ride stable engine releases (`vX.Y.Z`), where they were named
> after a CLI version npm had not published yet
> ([#728](https://github.com/drakulavich/kesha-voice-kit/issues/728)). Releases
> between `v1.24.7` and the first `-cli` release after that change carry no
> packages; the
> [releases page](https://github.com/drakulavich/kesha-voice-kit/releases)
> shows which. Prereleases ship none at all.

The packages install a standalone Bun-compiled CLI wrapper as `kesha`. Engine
binaries and models are still downloaded explicitly with `kesha install`
(~2.5 GB for speech-to-text; see [What Linux Gets](#what-linux-gets) below).

The wrapper is compiled with Bun's glibc target (`bun-linux-x64`) — it won't
run on musl-based distros (e.g. Alpine). Use the [Docker image](docker.md)
there instead.

## Download

The newest release is often an engine release, which carries no packages, so
resolve the latest `-cli` tag rather than asking for `latest`:

```bash
TAG=$(gh release list -R drakulavich/kesha-voice-kit --limit 50 --json tagName \
  --jq '[.[] | select(.tagName | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-cli$"))][0].tagName')
gh release download "$TAG" -R drakulavich/kesha-voice-kit \
  -p 'kesha-voice-kit_*_amd64.deb' -p 'kesha-voice-kit-*.x86_64.rpm' -p SHA256SUMS
sha256sum -c SHA256SUMS
```

No `gh` CLI? Pick the newest `vX.Y.Z-cli` release from the
[releases page](https://github.com/drakulavich/kesha-voice-kit/releases) and
download the assets by hand.

## Debian / Ubuntu

```bash
sudo apt install ./kesha-voice-kit_*_amd64.deb
kesha install
kesha audio.ogg
```

## Fedora / RHEL

```bash
sudo dnf install ./kesha-voice-kit-*.x86_64.rpm
kesha install
kesha audio.ogg
```

## What Linux Gets

Linux x64 — native packages, [Docker](docker.md), and the Nix `x86_64-linux`
path ([docs/nix-install.md](nix-install.md)) — all share the same feature set:

- **Speech-to-text**: ONNX CPU backend (no CoreML/ANE), same 25 languages as macOS.
- **Text-to-speech**: English, Spanish, French, Italian, Portuguese, and Russian
  (`kesha install --tts en es fr it pt ru`). Hindi/Japanese/Chinese and macOS
  system voices are darwin-arm64 only.
- **VAD**: supported (`kesha install --vad`).
- **Speaker diarization**: not available — darwin-arm64 only
  ([#199](https://github.com/drakulavich/kesha-voice-kit/issues/199)).

Full platform-by-platform breakdown:
[docs/product-positioning.md#platform-matrix](product-positioning.md#platform-matrix).

## Package Scope

The Linux packages install:

- `/usr/bin/kesha`
- license, notices, and README under `/usr/share/doc/kesha-voice-kit`

They depend on `ca-certificates` so `kesha install` can download release assets
and model files over HTTPS. They do not install the Rust engine or model files
during package installation.

## Maintainer Validation

Packaging uses [nFPM](https://nfpm.goreleaser.com/) to emit both formats from
the same config.

```bash
go install github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.43.4
node .github/scripts/build-linux-packages.mjs
.github/scripts/verify-linux-packages.sh
```

CI runs those same two commands through `.github/actions/linux-packages`, from
both `linux-packages.yml` (on `main`) and `release-cli.yml` (on a
`vX.Y.Z-cli` tag, which is what publishes them).
