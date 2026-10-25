## Why

Homebrew, the container image and the Nix flake install the CLI from sources. None of them stages `model-plan.json`, yet `src/install-plan.ts` and `src/voice-inventory.ts` have imported it since #659 (2026-07-31). On the published tap formula (v2.1.0), `kesha --version` works, but `kesha install` fails with `Cannot find module '../model-plan.json'`, so Maks can't download the Engine from a Homebrew install. On `main`, #1412 imports `install-plan` from `src/cli/main.ts`, which moves the crash onto the main command: `kesha --version` and `kesha --help` fail too. The scheduled `homebrew-formula` CI lane has failed every day since 2026-10-06 (#1429).

The same gap opened once before. #914 found `completions/` and `man/` missing from the same three payloads. The guard it left, `tests/unit/distribution-assets.test.ts`, checks a hand-written list of names, and `model-plan.json` was never on it.

There's a second defect. The release job writes only `url`, `sha256` and `version` into the tap's own formula, and the tap's `install` and `test do` blocks have never been synced from `packaging/homebrew/Formula/kesha-voice-kit.rb`. So #915's `completions` and `man` staging never reached Homebrew users, and the tap still writes the `parakeet` wrapper that #406 removed. Fixing the in-repo formula alone changes nothing for users.

## What Changes

- Homebrew, the `Dockerfile` and `flake.nix` stage `model-plan.json`.
- The guard derives the asset list from the code: every repository-root path that `src/` or `bin/` imports must be staged by each source payload and listed in `package.json#files`. A new import that a payload misses fails `bun test`.
- The formula's `test do` runs `kesha install --plan`, which reads `model-plan.json` and touches no network.
- The release job publishes the in-repo formula to the tap with only its pins rewritten. The tap drops the `parakeet` wrapper and gains `completions`, `man` and `model-plan.json`, and the release validator runs the full `test do` block before the push.

## Non-goals

- Running the container image in CI. Today CI only builds it; the static guard covers its staging.
- Making `nix build .#kesha` buildable (`lib.fakeHash`, see the `cli-distribution` Open Issues).
- Re-publishing the v2.1.0 tap formula. The fix reaches Homebrew users with the next stable release, unless the maintainer patches the tap by hand (Open Questions in `design.md`).
- Changing how the Linux packages compile. `bun build --compile` inlines the JSON import, so they are unaffected.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli-distribution`: the asset requirement gains an executable definition (whatever `src/` and `bin/` import), and a new requirement says the published tap formula is the in-repo formula.

## Impact

- `packaging/homebrew/Formula/kesha-voice-kit.rb`, `Dockerfile`, `flake.nix`
- `.github/scripts/update-homebrew-tap.mjs`
- `tests/unit/distribution-assets.test.ts`, `tests/unit/update-homebrew-tap.test.ts`
- Homebrew users lose the `parakeet` command at the next stable release. npm dropped it in #406.
