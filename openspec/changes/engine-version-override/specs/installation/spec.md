## ADDED Requirements

### Requirement: `--engine-version` installs a named Engine without changing the Pinned Engine version

`kesha install --engine-version <version>` SHALL download that Engine release instead of the
version pinned in `package.json#keshaEngine.version`, and SHALL record the installed version
next to the Engine binary so later commands report what is actually present. The flag SHALL
apply only to the invocation that names it: no file under version control is modified, and a
subsequent `kesha install` without the flag returns to the Pinned Engine version. A version
with no published release SHALL fail with an error naming the tag that was looked for, and
SHALL NOT fall back to the Pinned Engine version.

#### Scenario: Maks tries an Engine alpha before it is pinned

- GIVEN the Pinned Engine version is a stable release
- AND an Engine prerelease is published as `v1.24.8-alpha.1`
- WHEN Maks runs `kesha install --engine-version 1.24.8-alpha.1`
- THEN the Engine binary is downloaded from that release
- AND the recorded Engine version beside the binary is `1.24.8-alpha.1`
- AND `package.json` is unchanged
- AND the process exits 0

#### Scenario: Ira names a version that was never released

- GIVEN no release exists for the named version
- WHEN Ira runs `kesha install --engine-version 9.9.9`
- THEN the CLI prints an error naming the tag it looked for to stderr
- AND no Engine binary is downloaded or replaced
- AND the process exits 1

#### Scenario: Ira reverts to the pin

- GIVEN an Engine installed from `--engine-version 1.24.8-alpha.1`
- WHEN Ira runs `kesha install` with no override
- THEN the Pinned Engine version is downloaded, replacing the overridden one
- AND the recorded Engine version matches the Pinned Engine version

> *Technical Note — sources: `src/cli/install.ts::performInstall`,
> `src/engine-install.ts::downloadEngine` (:564-580 reads the version once for the release
> URL, the cache-validity comparison and the recorded version; the requested version must
> flow through all three). Related: `.github/scripts/check-versions.ts` rule 3 rejects an
> alpha in `package.json#keshaEngine.version`, which is why an override exists at all.*

### Requirement: `--plan` states the Engine version it would install

`kesha install --plan` SHALL state the Engine version the corresponding non-plan install
would download, including when `--engine-version` overrides the Pinned Engine version, so the
preview never names a version different from what the real install fetches.

#### Scenario: Maks previews an override

- WHEN Maks runs `kesha install --plan --engine-version 1.24.8-alpha.1`
- THEN the printed plan names `1.24.8-alpha.1` as the Engine version
- AND no download occurs

#### Scenario: Ira previews without an override

- WHEN Ira runs `kesha install --plan`
- THEN the printed plan names the Pinned Engine version

> *Technical Note — sources: `src/install-plan.ts`, `src/cli/install.ts`. The plan is
> reproducible output: it prints the command that would perform the install, so the override
> has to appear there too.*
