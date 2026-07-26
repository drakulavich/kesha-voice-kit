# Linux Packages

Kesha publishes `.deb` and `.rpm` packages for Linux x64 on stable engine
releases. They install a standalone Bun-compiled CLI wrapper as `kesha`.
Engine binaries and models are still downloaded explicitly with `kesha install`
(~2.7 GB for speech-to-text; see [What Linux Gets](#what-linux-gets) below).

The wrapper is compiled with Bun's glibc target (`bun-linux-x64`) — it won't
run on musl-based distros (e.g. Alpine). Use the [Docker image](docker.md)
there instead.

## Debian / Ubuntu

```bash
gh release download \
  -R drakulavich/kesha-voice-kit \
  -p 'kesha-voice-kit_*_amd64.deb'
sudo apt install ./kesha-voice-kit_*_amd64.deb
kesha install
kesha audio.ogg
```

No `gh` CLI? Download the same `.deb` from the
[latest release page](https://github.com/drakulavich/kesha-voice-kit/releases/latest).

## Fedora / RHEL

```bash
gh release download \
  -R drakulavich/kesha-voice-kit \
  -p 'kesha-voice-kit-*.x86_64.rpm'
sudo dnf install ./kesha-voice-kit-*.x86_64.rpm
kesha install
kesha audio.ogg
```

No `gh` CLI? Download the same `.rpm` from the
[latest release page](https://github.com/drakulavich/kesha-voice-kit/releases/latest).

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
sudo apt install ./dist/linux-packages/kesha-voice-kit_*_amd64.deb
kesha --version
kesha install --plan
sudo apt remove kesha-voice-kit
```
