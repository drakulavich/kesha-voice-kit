## ADDED Requirements

### Requirement: `--engine-version` installs a named Engine without changing the Pinned Engine version

`kesha install --engine-version <version>` SHALL download that Engine release (the binary and, on darwin-arm64, its Sidecars) instead of the Pinned Engine version, SHALL set the Recorded Engine version to it, and SHALL name it in the install summary. The version SHALL apply only to that invocation: nothing under version control changes, and a later `kesha install` without the flag reinstalls the Pinned Engine version.

#### Scenario: Maks tries an Engine prerelease before it is pinned

- GIVEN the Pinned Engine version is `2.3.0`
- AND an Engine prerelease is published as `v2.3.1-alpha.1`
- WHEN Maks runs `kesha install --engine-version 2.3.1-alpha.1`
- THEN the Engine binary and its Sidecars are downloaded from that release
- AND the Recorded Engine version is `2.3.1-alpha.1`
- AND the install summary names `2.3.1-alpha.1`
- AND `package.json` is unchanged
- AND the process exits 0

#### Scenario: Maks adds a voice and loses the override

- GIVEN an Engine installed from `--engine-version 2.3.1-alpha.1`
- WHEN Maks runs `kesha install --tts en` without repeating the flag
- THEN the Pinned Engine version is downloaded, replacing the overridden Engine
- AND the Recorded Engine version is the Pinned Engine version

#### Scenario: Maks keeps the override while adding a voice

- GIVEN an Engine prerelease is published as `v2.3.1-alpha.1`
- WHEN Maks runs `kesha install --engine-version 2.3.1-alpha.1 --tts en`
- THEN the named Engine is installed and the English voices are installed by it
- AND the Recorded Engine version is `2.3.1-alpha.1`

> *Technical Note — sources: `src/cli/install.ts::resolveEngineVersionFlag` and
> `performInstall`; `src/engine-install.ts::installEngine` takes the requested version
> and passes it to the binary URL, the cache comparison, the Recorded Engine version
> write and both Sidecar paths (the first download and the cache-hit top-up in
> `refreshCachedEngine`). Missing any one of them installs the override and then
> replaces it on its own cache check. Models need no separate rule: the model install
> runs through the Engine just installed, so model pins follow the binary. `kesha init`
> does not take the flag; it is the guided first-run path. Covered by
> `tests/unit/engine-version-override.test.ts` (#738).*

### Requirement: `--engine-version` rejects a bad value and never falls back to the pin

A value that is not an exact SemVer 2.0 version SHALL be rejected before any network call, with exit 2. A version with no published release SHALL fail with an error naming the release it looked for, with exit 1, and SHALL leave the binary already installed untouched rather than install the Pinned Engine version in its place.

#### Scenario: Ira names a version that was never released

- GIVEN no release exists for the named version
- WHEN Ira runs `kesha install --engine-version 9.9.9`
- THEN the CLI prints an error naming release `v9.9.9` to stderr
- AND the Pinned Engine version is not installed in its place
- AND the process exits 1

#### Scenario: Ira names something that is not a version

- WHEN Ira runs `kesha install --engine-version latest`
- THEN the CLI rejects the value with `E_INVALID_ARG` before contacting the network
- AND the process exits 2

> *Technical Note — sources: `src/cli/install.ts::resolveEngineVersionFlag` (a leading
> `v` gets its own hint, since it belongs to the tag), `src/engine-install.ts`, where a
> non-OK release response throws `E_MODEL_DOWNLOAD` naming `release v<version>`.*

### Requirement: An override reaches whatever Engine path is in effect

`kesha install --engine-version` SHALL install to the Engine path actually in use, including one redirected by `KESHA_ENGINE_BIN`, and SHALL replace a binary there whose Recorded Engine version differs. Where the Engine directory cannot be written, the install SHALL fail with an error naming that directory rather than report success against the binary already present.

#### Scenario: Ira overrides a redirected Engine path

- GIVEN `KESHA_ENGINE_BIN` points at a writable path holding a locally built Engine
- WHEN Ira runs `kesha install --engine-version 2.3.1-alpha.1`
- THEN the named Engine replaces the binary at that path
- AND the Recorded Engine version beside it is `2.3.1-alpha.1`

#### Scenario: Maks overrides against a read-only Engine directory

- GIVEN the Engine directory is read-only, as with a Nix-store install
- AND the Recorded Engine version differs from the named version
- WHEN Maks runs `kesha install --engine-version 2.3.1-alpha.1`
- THEN the CLI prints an error naming the directory it could not write
- AND does not report the install as successful

> *Technical Note — sources: `src/engine.ts::getEngineBinPath` (path only) and
> `src/engine-install.ts`, which refuses with `Cannot install engine v<version>: <dir>
> is not writable` before any download. A read-only directory still counts as a valid
> cache when the Recorded Engine version already matches. `flake.nix` and CI write the
> Recorded Engine version on purpose so an install treats a locally built Engine as a
> valid cache; replacing that binary is the documented result of asking for a
> different version.*

### Requirement: `--plan` previews the Engine version the install would fetch

`kesha install --plan` SHALL name the Engine version the corresponding install would download, SHALL judge cached-versus-needed against that version, and SHALL carry `--engine-version` into the `Run:` command it prints. It SHALL NOT download anything.

#### Scenario: Maks previews an override

- WHEN Maks runs `kesha install --plan --engine-version 2.3.1-alpha.1 --tts`
- THEN the plan reads `Engine release: v2.3.1-alpha.1 (overrides the pinned v<pin>)`
- AND it ends with `Run: kesha install --engine-version 2.3.1-alpha.1 --tts en`
- AND no download occurs

#### Scenario: Ira previews an override against an already-installed pin

- GIVEN an Engine installed at the Pinned Engine version
- WHEN Ira runs `kesha install --plan --engine-version 2.3.1-alpha.1`
- THEN the Engine is reported as needing download rather than as already present
- AND no download occurs

#### Scenario: Ira previews an invalid version

- WHEN Ira runs `kesha install --plan --engine-version latest`
- THEN the CLI rejects the value and prints no plan
- AND the process exits 2

> *Technical Note — sources: `src/install-plan.ts` (the plan options carry
> `engineVersion`; the header, the cached check and the Engine and Sidecar sources read
> it, and `buildInstallCommand` adds `--engine-version` to the `Run:` line). Sizes for a
> release the CLI does not pin are covered by "The Install plan sizes the Engine only
> from the release the CLI pins". Covered by `tests/unit/install-plan.test.ts` and the
> `--plan` case in `tests/integration/cli-contracts.test.ts` (#738).*
