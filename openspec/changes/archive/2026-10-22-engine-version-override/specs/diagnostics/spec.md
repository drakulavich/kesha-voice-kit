## ADDED Requirements

### Requirement: `kesha doctor` names an Engine that differs from the Pinned Engine version

`kesha doctor` SHALL report a Recorded Engine version that differs from the Pinned Engine version as a distinct named state, showing both versions, and SHALL NOT report the installation as failed on that basis alone, because installing a named Engine version is supported. Where the Recorded Engine version cannot be read at all, `kesha doctor` SHALL report that as its own state rather than as a difference.

#### Scenario: Maks forgets an override is installed

- GIVEN an Engine installed from `--engine-version 2.3.1-alpha.1`
- AND a Pinned Engine version of `2.3.0`
- WHEN Maks runs `kesha doctor`
- THEN the output names both the Recorded and the Pinned Engine version and says they differ
- AND the Engine is not reported as missing or broken

#### Scenario: Ira runs doctor on an unmodified install

- GIVEN an Engine installed at the Pinned Engine version
- WHEN Ira runs `kesha doctor`
- THEN the version state reads that it matches the pin
- AND no version difference is reported

#### Scenario: Maks has an Engine binary with no recorded version

- GIVEN an Engine binary is present with no readable Recorded Engine version
- WHEN Maks runs `kesha doctor`
- THEN the output states that no version is recorded beside the binary
- AND does not claim the Engine differs from the Pinned Engine version

> *Technical Note — sources: `src/doctor.ts::engineVersionState` (`matches-pin`,
> `differs-from-pin`, `unrecorded`, and `unsupported` for a Recorded Engine version older
> than `MIN_ENGINE_VERSION`, which #1365 added and which takes precedence over a
> difference), `formatVersionState` (the `Version state:` line) and `formatDoctorReport`
> (`Version marker:` and `Pinned version:`). The marker file is written on purpose by
> `flake.nix` and by CI so an install treats a locally built Engine as a valid cache.
> Covered by `tests/unit/doctor.test.ts`.*
