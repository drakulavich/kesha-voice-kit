# CLI Distribution Specification

## Purpose

This spec covers how the `kesha` CLI itself reaches a machine — the npm CLI
package and every wrapper built on top of it: Homebrew, `.deb`/`.rpm`, the GHCR
container image, and the Nix flake. It also covers the MCP registry manifest,
which advertises the same npm package to MCP clients. Ira picks a distribution
path that fits a CI image; Maks installs from Homebrew on his Mac; Sona points
an MCP client at the published registry entry.

The [installation](../installation/spec.md) spec starts where this one stops:
once `kesha` is on PATH, acquiring the Engine and models is `kesha install`'s
job, and no distribution path changes that.

## Non-Goals

- Downloading the Engine or models. Every path below ships the CLI only; the
  Never-auto-download rule holds across all of them.
- Choosing which Engine release a CLI resolves — that is the Pinned Engine
  version, specified in [installation](../installation/spec.md).
- Which version reaches which Channel, and when. Release-lane mechanics live in
  the release-channels capability.
- The shape of the `./core` exports map — see
  [programmatic-api](../programmatic-api/spec.md).
- Publishing the OpenClaw plugin to ClawHub — see
  [openclaw-plugin](../openclaw-plugin/spec.md).

## Requirements

### Requirement: Every distribution path delivers the same CLI, built from the CLI package

Each supported distribution path SHALL deliver the CLI package's `bin/kesha.js` entry point and its sources, and SHALL report the same version the CLI package carries. A path MAY compile that entry point into a standalone binary instead of shipping the sources, but no path may deliver a CLI built from anything else.

#### Scenario: Maks installs from Homebrew instead of npm

- GIVEN Maks has never installed Kesha
- WHEN Maks runs `brew install drakulavich/tap/kesha-voice-kit`
- THEN `kesha --version` prints the same version the npm CLI package carries
- AND the installed command runs the same `bin/kesha.js` entry point that
  `bun add -g @drakulavich/kesha-voice-kit` would install

#### Scenario: Ira installs the .deb, which carries no sources

- GIVEN the Linux package installs a standalone binary rather than the sources
- WHEN Ira runs `kesha --help`
- THEN it prints the same command list as a global install of the same version,
  because the binary was compiled from that version's entry point

#### Scenario: A path builds the CLI from something other than the package

- WHEN a distribution path would ship a CLI not derived from the CLI package at
  that version
- THEN it is not a supported path

> *Technical Note — `bin/kesha.js:1-4` is a four-line `#!/usr/bin/env bun`
> shim over `runCli` from `src/cli/dispatch.ts`. `package.json#bin` maps
> `kesha → bin/kesha.js`; `package.json#files` publishes `bin/` and `src/`
> as-is. Homebrew installs `bin`, `src`, `package.json`, `bun.lock`,
> `tsconfig.json` into `libexec` and writes a shell wrapper that execs Bun
> against `libexec/bin/kesha.js`
> (`packaging/homebrew/Formula/kesha-voice-kit.rb:11-24`). `Dockerfile:10-19`
> copies `bin` and `src` and symlinks `/usr/local/bin/kesha`. The Linux packages
> are the compiled case: `.github/scripts/build-linux-packages.mjs:27-34` runs
> `bun build --compile --target=bun-linux-x64 ./bin/kesha.js` and nfpm packages
> the single resulting file.*

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

> *Technical Note — `package.json#engines.bun` is `>=1.3.0`
> (`package.json:88-90`). `packaging/homebrew/Formula/kesha-voice-kit.rb:8`
> declares `depends_on "oven-sh/bun/bun"`. `Dockerfile:1` pins
> `oven/bun:1.3.14-slim`. The Linux binary is compiled for `bun-linux-x64`
> (glibc); `docs/linux-packages.md` states the musl limitation and points at the
> container image.*

### Requirement: The published package runs no install-time lifecycle script

The CLI package SHALL declare no `postinstall` or equivalent lifecycle script, so that installing it downloads nothing beyond the package itself.

#### Scenario: Ira installs the CLI inside a CI image build

- WHEN Ira runs `bun add -g @drakulavich/kesha-voice-kit` in a Dockerfile layer
- THEN the install completes without contacting GitHub Releases or HuggingFace
- AND the layer grows by the package size only, not by gigabytes of models

#### Scenario: A lifecycle script is added

- WHEN a `postinstall` script is added to the CLI package
- THEN the package-metadata check fails, because the Never-auto-download rule
  must hold at the package-manager level too

> *Technical Note — asserted by `tests/unit/package-metadata.test.ts` ("does
> not publish lifecycle scripts"), which also asserts `model-plan.json` stays
> in `package.json#files` so `kesha install --plan` can size the download
> without the Engine present.*

### Requirement: The published file list carries runtime assets and excludes test sources

The CLI package SHALL publish everything the CLI reads at runtime — the entry point, sources, shell completion scripts, the man page, the install plan metadata, and the OpenClaw plugin files — and SHALL exclude test sources.

#### Scenario: Maks prints completions from a global install

- GIVEN Maks installed the CLI from npm and never cloned the repository
- WHEN Maks runs `kesha completions zsh` and `kesha manpage`
- THEN both print their bundled files, because `completions/` and `man/` ship
  in the package and are resolved relative to the installed sources

#### Scenario: A script names a repository path that is not published

- WHEN a `package.json` script references a path under `tests/`, `src/`,
  `scripts/`, or `.github/` that does not exist
- THEN the package-metadata check fails, naming the script and the path

> *Technical Note — `package.json#files` (`package.json:13-30`) lists `bin/`,
> `completions/`, `man/`, `src/`, `model-plan.json`, `package.json`,
> `tsconfig.json`, `openclaw.plugin.json`, `openclaw-plugin.cjs`, two docs
> pages, `SKILL.md`, `LICENSE`, `NOTICES.md`, `README.md`, and the
> `!src/__tests__` exclusion. `tests/unit/package-metadata.test.ts` covers the
> `model-plan.json` entry and the script-path existence check.*

### Requirement: Linux packages install one command and its documentation

A `.deb` or `.rpm` SHALL install the `kesha` command to a directory already on the default PATH, install the licence and notices alongside it, and declare the certificate bundle it needs to reach GitHub Releases during a later `kesha install`.

#### Scenario: Ira installs the .deb on a minimal image

- GIVEN a minimal `amd64` Debian image
- WHEN Ira installs the published `.deb`
- THEN `kesha` resolves on PATH without further configuration
- AND `kesha install` can reach GitHub Releases, because `ca-certificates` came
  in as a dependency

#### Scenario: A non-amd64 Linux host

- GIVEN an `arm64` Linux host
- WHEN the user looks for a Linux package
- THEN none is published for that architecture, and the documented path is the
  npm CLI package

> *Technical Note — `packaging/nfpm.yaml`: `arch: amd64`, `kesha → /usr/bin`
> mode 0755, `LICENSE` / `NOTICES.md` / `README.md` under
> `/usr/share/doc/kesha-voice-kit/`, and a `ca-certificates` dependency in both
> the `deb` and `rpm` overrides. Which release may attach them is specified in
> [installation](../installation/spec.md) ("Linux packages ship only from a
> release that publishes the same CLI version"); build-side coverage lives in
> `tests/unit/linux-packaging.test.ts`.*

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
> `USER bun`, `WORKDIR /work`, `ENTRYPOINT ["kesha"]`, `CMD ["--help"]`, plus a
> legacy `/usr/local/bin/parakeet` symlink beside `kesha`. Published to GHCR by
> `.github/workflows/docker.yml` for `linux/amd64` only, on pushes to `main`
> and on `v*` tags excluding `v*-alpha*`. `compose.yml` mirrors the same mount
> layout; usage is documented in `docs/docker.md`.*

### Requirement: The Nix flake builds the CLI and the Engine from source

The Nix flake SHALL expose the CLI and a from-source Engine build for `aarch64-darwin` and `x86_64-linux`, with the CLI pointed at the Engine the same flake built. It is an alternate reproducible path, not a release gate — no published artifact depends on it.

#### Scenario: Maks runs Kesha through Nix without an npm install

- GIVEN Maks has Nix with flakes enabled on Apple Silicon
- WHEN Maks runs `nix run github:drakulavich/kesha-voice-kit -- install`
- THEN the CLI runs against the Engine built by the flake rather than a
  downloaded release binary

#### Scenario: The flake fails to evaluate

- WHEN the flake breaks on a supported system
- THEN no release lane fails as a result, because no published artifact is built
  through it

> *Technical Note — `flake.nix` exposes `packages.kesha` and
> `packages.kesha-engine`; `kesha-engine` is built with naersk and records
> `package.json#keshaEngine.version` into `bin/kesha-engine.version`
> (`flake.nix:144-167`), and the `kesha` wrapper sets `KESHA_ENGINE_BIN` to it
> (`flake.nix:280`). Usage: `docs/nix-install.md`. CLAUDE.md states explicitly
> that the flake is not a CI gate.*

### Requirement: The MCP registry manifest names a published CLI version

The MCP registry manifest SHALL name the npm CLI package and a version equal to the CLI version in the repository, and the drift gate SHALL fail when they disagree, so a client resolving the registry entry never asks npm for a version that was never published.

#### Scenario: Sona adds Kesha from the MCP registry

- GIVEN Sona's MCP client resolves the registry entry
- WHEN the client launches the server
- THEN it runs the published npm CLI package with the `mcp` argument over stdio,
  which is the invocation [mcp-server](../mcp-server/spec.md) specifies

#### Scenario: A version bump misses the manifest

- GIVEN the CLI version is bumped in `package.json` only
- WHEN the version drift gate runs
- THEN it fails, naming both versions

#### Scenario: The manifest is missing or unreadable

- WHEN the manifest cannot be read from the repository root
- THEN the drift gate fails with a message saying the manifest must stay there

> *Technical Note — `server.json` carries `version` and
> `packages[0].version`, `registryType: npm`, `transport: stdio`, and the
> positional `mcp` argument. `.github/scripts/check-versions.ts` reads it and
> exits non-zero on drift or on an unreadable file; run as
> `bun run check:versions`, part of `bun run check`.*

### Requirement: No distribution path downloads the Engine or models

Whichever path put `kesha` on the machine, the Engine and models SHALL still arrive only through an explicit `kesha install` (or `kesha init`).

#### Scenario: Maks transcribes immediately after `brew install`

- GIVEN Maks has just installed the Homebrew formula
- WHEN Maks runs `kesha meeting.ogg`
- THEN the CLI fails with an error naming the missing component and a
  `kesha install` hint
- AND nothing is downloaded

#### Scenario: Ira builds a CI image and expects models baked in

- WHEN Ira installs the `.deb` in an image build and runs no `kesha install`
- THEN the image contains the CLI only, and the first transcription in that
  image fails with the same install hint

> *Technical Note — the rule and its enforcement points are specified in
> [installation](../installation/spec.md); this requirement exists so no
> distribution path is read as an exception to it.*

## Open Issues

- **`kesha completions` and `kesha manpage` are broken on the Linux-package
  path.** Both read their file relative to `import.meta.url`
  (`src/cli/completions.ts:38`, `src/cli/manpage.ts:9`), which in a
  `bun build --compile` binary resolves outside the embedded filesystem. Every
  other path ships the sources, so only the `.deb`/`.rpm` is affected.
  Reproduced against this commit by compiling `./bin/kesha.js` for the host and
  running both commands: each dies with an unhandled `ENOENT` for
  `/completions/kesha.bash` and `/man/kesha.1` respectively, printing a stack
  trace and exiting 1 — not the exit-2 usage error
  [cli-shell-integration](../cli-shell-integration/spec.md) specifies for bad
  input, and not a message a user can act on. `model-plan.json` is unaffected
  because it is a static import, and `kesha install --plan` was verified working
  in the same binary. Needs a GitHub issue; the fix is to embed both assets
  rather than resolve them at runtime.
- The Homebrew formula in `packaging/homebrew/Formula/kesha-voice-kit.rb` is a
  template kept in this repository; the tap that users install from is
  `drakulavich/homebrew-tap`, updated by `.github/workflows/homebrew-tap.yml`
  on `release: published`. The in-repo copy pins an older version
  (`v1.18.0`) than the current CLI, and nothing fails when it goes stale —
  there is no check that the in-repo template and the published tap agree.
- `homebrew-tap.yml` fires on every published release, including Engine
  releases that publish no CLI version (see CLAUDE.md, "un-drafting an engine
  tag still fires 🍺 Homebrew Tap"). The lane's own skip logic is the only thing
  keeping an Engine tag out of the tap; that skip is not specified here.
- The container image publishes on every push to `main`, so the `main`-tagged
  image can be ahead of any released CLI version. Only tag-triggered images
  correspond to a release.
- `Dockerfile` still installs a `/usr/local/bin/parakeet` symlink. No spec, doc,
  or test references that name; it appears to be a legacy alias with no stated
  deprecation.
- No test asserts that the Homebrew, Linux-package, container, and Nix paths
  produce the same CLI version — the "same contents everywhere" requirement is
  held by construction, not by a gate.
