## MODIFIED Requirements

### Requirement: Bun is present on every distribution path, as a dependency or compiled in

The CLI package SHALL declare Bun >= 1.3.0 as its required runtime, and every wrapper path SHALL either depend on Bun, bundle it, or embed it in a compiled binary, so that a successful install never produces a `kesha` that cannot start.

#### Scenario: Maks installs the Homebrew formula on a Mac without Bun

- GIVEN Bun is not installed
- WHEN Maks runs `brew install drakulavich/tap/kesha-voice-kit`
- THEN Homebrew installs Bun as a dependency first
- AND `kesha --version` succeeds afterwards

#### Scenario: Ira installs the .deb on a host with no Bun

- GIVEN no Bun is installed on a glibc-based `amd64` host
- WHEN Ira installs the `.deb` and runs `kesha --version`
- THEN it succeeds, because the runtime is embedded in the compiled binary

#### Scenario: The compiled binary meets a C library it was not built for

- GIVEN a musl-based distribution such as Alpine
- WHEN the Linux package's binary is run there
- THEN it does not run, and the documented alternative is the container image

#### Scenario: A user runs the entry point under a runtime that is not Bun

- GIVEN a user invokes `bin/kesha.js` with a runtime other than Bun
- THEN startup fails, because the CLI uses Bun-native APIs and ships no
  compatibility layer

> *Technical Note — `package.json#engines.bun` is `>=1.3.0`.
> `packaging/homebrew/Formula/kesha-voice-kit.rb` declares
> `depends_on "oven-sh/bun/bun"`. The `Dockerfile` pins
> `oven/bun:1.4.0-slim`. The Linux binary is compiled for `bun-linux-x64`
> (glibc); `docs/distribution.md` states the musl limitation and points at the
> container image.*

### Requirement: The container image is file-in, file-out and keeps the Model cache on a mount point

The published container image SHALL run the CLI as a non-root user, resolve the Model cache to a fixed path a volume can be mounted at, and default its working directory to a mount point for the user's audio. Microphone capture is not available inside the image.

#### Scenario: Ira transcribes a file with the container image

- GIVEN Ira mounts a named volume at the cache path and the working directory at
  the work path
- WHEN Ira runs the image with `install` and then with `audio.ogg`
- THEN the models land in the mounted volume and are reused by the second run
- AND the transcript is written to stdout

#### Scenario: Ira tries to record inside the container

- WHEN Ira runs `record --out out.wav` in the container
- THEN recording fails, because the container has no microphone access

#### Scenario: The cache path is not mounted

- WHEN Ira runs the image twice without mounting the cache path
- THEN the second run finds no Engine and asks for `kesha install`, because the
  first run's download died with its container

> *Technical Note — `Dockerfile`: `KESHA_CACHE_DIR=/cache/kesha`,
> `USER bun`, `WORKDIR /work`, `ENTRYPOINT ["kesha"]`, `CMD ["--help"]`. Published to GHCR for
> `linux/amd64` only: by the `docker` job of `.github/workflows/release.yml` on a
> stable release, and by the `docker-image` job of `.github/workflows/ci.yml` on a
> push to `main` that changes what the image packs. `compose.yml` mirrors the same mount
> layout; usage is documented in `docs/docker.md`.*

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
- WHEN a user reads the README or `docs/distribution.md`
- THEN no doc presents `nix run` / `nix profile install .#kesha` as a working
  install method — the only documented Nix path is `nix build .#kesha-engine`
- AND the flake still exposes `.#kesha`, so a maintainer with Nix can populate
  the hash (or adopt `bun2nix`) and re-document the CLI path
- AND no release lane fails as a result

> *Technical Note — `flake.nix` exposes `packages.kesha` and
> `packages.kesha-engine`; `kesha-engine` is built with naersk and records
> `package.json#version`, the one version the CLI and the Engine share, into `bin/kesha-engine.version`
> (`flake.nix::kesha-engine`), and the `kesha` wrapper sets `KESHA_ENGINE_BIN`
> to it (`flake.nix::kesha`). `rustFeatures` in `flake.nix` is `portable,system_tts` on
> darwin-arm64 and `portable` elsewhere; the comment above it records why the
> flake cannot build the `darwin` profile (SwiftPM clones offline). `flake.nix::keshaNodeModules` has
> `outputHash = lib.fakeHash`, and the comment above it states
> plainly that `packages.default`, `apps.default`, and any `nix run` /
> `nix profile install .#kesha` invocation fail until it is populated — so the
> docs (README "Other install methods", `docs/distribution.md`) present only
> `nix build .#kesha-engine` as usable and mark the CLI path as not yet
> available (#946). CLAUDE.md states the flake is not a CI gate; `nix-build.yml`
> builds `.#kesha-engine` only, on a pull request that touches the flake and
> weekly, and stays a standalone workflow outside the required checks.*
