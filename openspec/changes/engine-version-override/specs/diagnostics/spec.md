## ADDED Requirements

### Requirement: `kesha doctor` reports an Engine that differs from the Pinned Engine version

`kesha doctor` SHALL report an installed Engine whose recorded version differs from
`package.json#keshaEngine.version` as a distinct named state, showing both versions. It SHALL
NOT report the installation as failed on that basis alone, because installing a named Engine
version is supported.

#### Scenario: Maks forgets an override is installed

- GIVEN an Engine installed from `--engine-version 1.24.8-alpha.1`
- AND a Pinned Engine version of `1.24.7`
- WHEN Maks runs `kesha doctor`
- THEN the output names both the installed and the Pinned Engine version
- AND the Engine is not reported as missing or broken

#### Scenario: Ira runs doctor on an unmodified install

- GIVEN an Engine installed at the Pinned Engine version
- WHEN Ira runs `kesha doctor`
- THEN no version drift is reported

> *Technical Note — sources: `src/doctor.ts::collectEngine`,
> `src/engine-install.ts::readInstalledEngineVersion`. The recorded version lives in a
> `.version` file beside the binary; CI writes it deliberately so an install treats a
> locally built Engine as a valid cache (`ci.yml`, `build-engine.yml`).*
