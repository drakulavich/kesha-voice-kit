## MODIFIED Requirements

### Requirement: Every payload carries the assets the CLI loads, and no test sources

Each distribution path SHALL stage every repository-root file or directory that `src/` or `bin/` imports, beside the entry point and sources, and SHALL exclude test sources. Today that set is `completions/`, `man/`, `model-plan.json` and `package.json`; the OpenClaw plugin files ship as well. A payload that stages the sources without the assets beside them is incomplete, not merely reduced: the commands that need them fail.

#### Scenario: Maks prints completions from a global install

- GIVEN Maks installed the CLI from npm and never cloned the repository
- WHEN Maks runs `kesha completions zsh` and `kesha manpage`
- THEN both print their bundled files, because `completions/` and `man/` ship
  in the package and are resolved relative to the installed sources

#### Scenario: Maks previews the install plan from Homebrew

- GIVEN Maks installed the CLI with `brew install drakulavich/tap/kesha-voice-kit`
- WHEN Maks runs `kesha install --plan`
- THEN it prints the plan and exits 0, because `model-plan.json` is staged
  beside the sources

#### Scenario: A payload stages the sources but not the assets

- GIVEN a payload that stages `bin/` and `src/` without `model-plan.json`
- WHEN a user runs any command that loads `src/install-plan.ts`
- THEN the command fails with `Cannot find module '../model-plan.json'`
  rather than running, because the asset is not on disk where the source
  expects it

#### Scenario: A new source imports a root asset that a payload misses

- GIVEN a change adds an import from `src/` of a repository-root path
- AND the formula, the `Dockerfile`, `flake.nix` or `package.json#files` does
  not stage that path
- WHEN `bun test` runs
- THEN the distribution-assets test fails, naming the payload and the path

#### Scenario: A script names a repository path that is not published

- WHEN a `package.json` script references a path under `tests/`, `src/`,
  `scripts/`, or `.github/` that does not exist
- THEN the package-metadata check fails, naming the script and the path

> *Technical Note — the root imports are `src/cli/completions.ts:5-7`,
> `src/cli/manpage.ts:3`, `src/install-plan.ts:12`, `src/voice-inventory.ts:3`
> and `src/package-info.ts:1`. `package.json#files` lists `bin/`,
> `completions/`, `man/`, `src/`, `model-plan.json`, `package.json`,
> `tsconfig.json`, `openclaw.plugin.json`, `openclaw-plugin.cjs`, two docs
> pages, `SKILL.md`, `LICENSE`, `NOTICES.md`, `README.md`, and the
> `!src/__tests__` exclusion. `tests/unit/distribution-assets.test.ts` derives
> the asset set from those imports and checks
> `packaging/homebrew/Formula/kesha-voice-kit.rb`, `Dockerfile`, `flake.nix`
> and `package.json#files`. The Linux packages compile with `bun build
> --compile`, which inlines these imports.*

## ADDED Requirements

### Requirement: The published Homebrew formula is the in-repository formula

The tap formula that a stable release publishes SHALL equal `packaging/homebrew/Formula/kesha-voice-kit.rb` at the release tag, except for its `url`, `sha256` and `version` pins, and the release SHALL run that formula's full `test do` block before pushing it.

#### Scenario: A release carries a staging fix to Homebrew users

- GIVEN the in-repo formula stages `model-plan.json` at tag `vX.Y.Z`
- AND the tap formula from the previous release does not
- WHEN the release's `homebrew` job publishes `vX.Y.Z`
- THEN the tap formula stages `model-plan.json`, and `kesha install --plan`
  works after `brew upgrade`

#### Scenario: The tap carries a block the repository dropped

- GIVEN the tap formula still writes a `parakeet` wrapper that the in-repo
  formula removed
- WHEN the next stable release updates the tap
- THEN the published formula has no `parakeet` wrapper

#### Scenario: The in-repo formula fails its own test

- GIVEN the formula at the release tag fails `brew test`
- WHEN the release's `homebrew` job validates it
- THEN the job fails before `push-homebrew-tap.sh`, and the tap keeps the
  previous formula

> *Technical Note — `.github/workflows/release.yml` job `homebrew` runs
> `.github/scripts/update-homebrew-tap.mjs`, then
> `.github/scripts/validate-homebrew-formula.sh` (`brew install
> --build-from-source`, `brew audit --strict`, `brew test`), then
> `.github/scripts/push-homebrew-tap.sh`. `buildUpdatedFormula` rewrites pins
> with `rewriteFormula` from `.github/scripts/stage-homebrew-worktree-formula.mjs`.*
