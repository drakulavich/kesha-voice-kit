## ADDED Requirements

### Requirement: `kesha doctor` names an Engine that differs from the Pinned Engine version

`kesha doctor` SHALL report a Recorded Engine version that differs from the Pinned Engine
version as a distinct named state, showing both versions. It SHALL NOT report the
installation as failed on that basis alone, because installing a named Engine version is
supported. Where the Recorded Engine version cannot be read at all, `kesha doctor` SHALL
report that as its own state rather than as a difference from the Pinned Engine version.

#### Scenario: Maks forgets an override is installed

- GIVEN an Engine installed from `--engine-version 1.24.8-alpha.1`
- AND a Pinned Engine version of `1.24.7`
- WHEN Maks runs `kesha doctor`
- THEN the output names both the Recorded and the Pinned Engine version
- AND the Engine is not reported as missing or broken

#### Scenario: Ira runs doctor on an unmodified install

- GIVEN an Engine installed at the Pinned Engine version
- WHEN Ira runs `kesha doctor`
- THEN no version difference is reported

#### Scenario: Maks has an Engine binary with no recorded version

- GIVEN an Engine binary is present with no readable Recorded Engine version
- WHEN Maks runs `kesha doctor`
- THEN the output states that the Recorded Engine version is missing
- AND does not claim the Engine differs from the Pinned Engine version

> *Technical Note — sources: `src/doctor.ts::collectEngine` (:195 reads the marker),
> `formatDoctorReport` (:456 prints `Version marker:`, or `missing`),
> `src/engine-install.ts::readInstalledEngineVersion`. The marker is already printed today;
> what is absent is the Pinned Engine version beside it and any statement that the two
> disagree, so a drifted install reads as healthy. The marker file is written deliberately by
> `flake.nix` and by CI so an install treats a locally built Engine as a valid cache.*
