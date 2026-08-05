## ADDED Requirements

### Requirement: `--engine-version` installs a named Engine without changing the Pinned Engine version

`kesha install --engine-version <version>` SHALL download that Engine release — binary and,
on darwin-arm64, its Sidecars — instead of the Pinned Engine version, and SHALL set the
Recorded Engine version to what it installed. The named version SHALL apply only to the
invocation that names it: nothing under version control is modified, and any later
`kesha install` without the flag reinstalls the Pinned Engine version, replacing what the
override put there. A value that is not valid SemVer SHALL be rejected before any network
call, and a version with no published release SHALL fail with an error naming the tag it
looked for, never falling back to the Pinned Engine version. The install summary SHALL name
the Engine version it installed.

#### Scenario: Maks tries an Engine alpha before it is pinned

- GIVEN the Pinned Engine version is a stable release
- AND an Engine prerelease is published as `v1.24.8-alpha.1`
- WHEN Maks runs `kesha install --engine-version 1.24.8-alpha.1`
- THEN the Engine binary and its Sidecars are downloaded from that release
- AND the Recorded Engine version is `1.24.8-alpha.1`
- AND the install summary names `1.24.8-alpha.1`
- AND `package.json` is unchanged
- AND the process exits 0

#### Scenario: Ira names a version that was never released

- GIVEN no release exists for the named version
- WHEN Ira runs `kesha install --engine-version 9.9.9`
- THEN the CLI prints an error naming the tag it looked for to stderr
- AND the Pinned Engine version is not installed in its place
- AND the process exits 1

#### Scenario: Ira names something that is not a version

- WHEN Ira runs `kesha install --engine-version latest`
- THEN the CLI rejects the value before contacting the network
- AND the process exits 2

#### Scenario: Maks adds a voice and loses the override

- GIVEN an Engine installed from `--engine-version 1.24.8-alpha.1`
- WHEN Maks runs `kesha install --tts en` without repeating the flag
- THEN the Pinned Engine version is downloaded, replacing the overridden Engine
- AND the Recorded Engine version is the Pinned Engine version

#### Scenario: Maks keeps the override while adding a voice

- GIVEN an Engine alpha is published
- WHEN Maks runs `kesha install --engine-version 1.24.8-alpha.1 --tts en`
- THEN the named Engine is installed and the English voices are installed by it
- AND the Recorded Engine version is `1.24.8-alpha.1`

> *Technical Note — sources: `src/cli/install.ts::performInstall`,
> `src/engine-install.ts::downloadEngine` (:564-580 compares the Recorded Engine version
> against the Pinned Engine version to decide cache validity), `:439` (binary URL), `:445`
> and `:358` (Sidecar download and cache top-up, both passing the same version), `:473`
> (writes the Recorded Engine version). The module-level `engineVersion` import is read at
> fifteen sites in that file; every one on the install path must follow the requested
> version, or the override installs and is then replaced by its own cache check. Models need
> no separate rule: `runEngineModelInstall` delegates to the Engine just installed, so model
> Pinned hashes follow the binary. Paired with #736, which forbids an alpha in the Pinned
> Engine version — this flag is what that rule leaves in its place.*

### Requirement: An override reaches whatever Engine path is in effect

`kesha install --engine-version` SHALL install to the Engine path actually in use, including
one redirected by `KESHA_ENGINE_BIN`, and SHALL replace a binary already there whose Recorded
Engine version differs. Where the Engine directory cannot be written, the install SHALL fail
with an actionable error rather than reporting success against the binary already present.

#### Scenario: Ira overrides a redirected Engine path

- GIVEN `KESHA_ENGINE_BIN` points at a writable path holding a locally built Engine
- WHEN Ira runs `kesha install --engine-version 1.24.8-alpha.1`
- THEN the named Engine replaces the binary at that path
- AND the Recorded Engine version beside it is `1.24.8-alpha.1`

#### Scenario: Maks overrides against a read-only Engine directory

- GIVEN the Engine directory is read-only, as with a Nix-store install
- AND the Recorded Engine version differs from the named version
- WHEN Maks runs `kesha install --engine-version 1.24.8-alpha.1`
- THEN the CLI prints an error naming the directory it could not write
- AND does not report the install as successful

> *Technical Note — sources: `src/engine.ts::getEngineBinPath` (:42-45, path only),
> `src/engine-install.ts::fetchEngineBinary` (writes to the resolved path) and
> `checkEngineWritable` (:569). A read-only directory is treated as cache-valid today only
> when the versions already match (:571-574); an override naming a different version has no
> such escape. `flake.nix` writes the Recorded Engine version deliberately so an install
> treats the store binary as a valid cache, and CI does the same (`ci.yml`,
> `build-engine.yml`) — replacing that binary is the documented consequence of asking for a
> different version, not an accident to guard against.*

### Requirement: `--plan` previews the Engine version the install would fetch

`kesha install --plan` SHALL state the Engine version the corresponding non-plan install would
download, and SHALL carry `--engine-version` into the reproducible command it prints, so the
preview never names or reproduces a version different from what the real install fetches. The
cached-versus-needed state it reports SHALL be judged against that same version, and `--plan`
SHALL NOT download anything.

#### Scenario: Maks previews an override

- WHEN Maks runs `kesha install --plan --engine-version 1.24.8-alpha.1`
- THEN the printed plan names `1.24.8-alpha.1` as the Engine version
- AND the command it prints for reproducing the install includes `--engine-version 1.24.8-alpha.1`
- AND no download occurs

#### Scenario: Ira previews an override against an already-installed pin

- GIVEN an Engine installed at the Pinned Engine version
- WHEN Ira runs `kesha install --plan --engine-version 1.24.8-alpha.1`
- THEN the Engine is reported as needing download rather than as already present
- AND no download occurs

#### Scenario: Ira previews an invalid version

- WHEN Ira runs `kesha install --plan --engine-version latest`
- THEN the CLI rejects the value and prints no plan
- AND the process exits 2

> *Technical Note — sources: `src/install-plan.ts` — the Pinned Engine version is read at
> `:188` (cached check), `:191` (Engine source), `:211` (Sidecar source) and `:336` (header),
> and `buildInstallCommand` (:405, printed at :432) composes the reproducible command and
> today carries no version flag. Changing the header alone leaves three of those five wrong.*

## Open Issues

- Whether `kesha init` accepts `--engine-version`. Init is the guided first-run path and an
  override is an expert action, which argues for leaving it out — but nothing yet decides it.
- Whether the programmatic `downloadModel` API takes the same option. Sona's use cases do not
  obviously need it, and it would widen a stable public surface.
- Whether an Engine whose Capabilities JSON protocol the CLI cannot parse should be refused at
  install time or left to surface later. A numeric major-version guard and a behavioural
  protocol check are different answers and this change does not pick one.
- Whether a download failing mid-stream can leave a partial binary beside a stale Recorded
  Engine version. `streamResponseToFile` writes in place, so this predates the override; the
  error scenarios here deliberately promise only that a missing release installs nothing.
