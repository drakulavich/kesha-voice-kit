# Release Manifest

`kesha-release-manifest.json` is packaging metadata published with every engine
release. It is a small, stable JSON contract for package-manager channels such
as Homebrew, deb, or rpm.

The manifest does not replace the user-facing Bun install path:

```bash
bun add -g @drakulavich/kesha-voice-kit
kesha install
```

## Contents

For stable `vX.Y.Z` releases, the manifest records:

- the repository, release tag, CLI version, and engine version
- released engine binaries and macOS sidecars
- released Linux `.deb` and `.rpm` packages
- the install layout used by `kesha install`
- supported platform status for package managers
- checksum and Sigstore bundle naming conventions

The manifest accepts three tag shapes — `vX.Y.Z`, `vX.Y.Z-beta.N`, and
`vX.Y.Z-alpha.N` — and rejects anything else. For the two prerelease shapes,
Linux `.deb` and `.rpm` package assets are omitted. `engineVersion` comes from
the tag rather than from `package.json#keshaEngine.version`: an alpha ships a
version no commit carries, and it must outrank the pin rather than equal it
(#738). Channel policy — what each prerelease is for and how it reaches users —
lives in the `release-mechanics` skill.

`SHA256SUMS` and Sigstore bundles cover the manifest itself, so downstream
packaging can verify the metadata before consuming it.

## Validation

Run the local consistency check after changing release asset names, install
layout, or release workflow packaging:

```bash
bun run check:release-manifest
```

The check fails if manifest metadata drifts from `src/engine-install.ts` or
`.github/workflows/build-engine.yml`.
