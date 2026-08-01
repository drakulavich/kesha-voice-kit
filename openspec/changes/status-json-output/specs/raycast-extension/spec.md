## MODIFIED Requirements

### Requirement: Setup problems surface before recording

Before entering the recording state, the extension SHALL probe the resolved CLI (version/engine availability) and, on failure, render a dedicated finish-setup view naming the exact remaining command instead of starting a recording that cannot succeed.

The probe SHALL decide Engine availability from the CLI's machine-readable status
output rather than by matching human-readable prose, so that rewording the CLI's
status text cannot break a published extension.

Engine availability SHALL mean present AND reporting readable capabilities. An
Engine binary that exists but cannot report its capabilities is unusable, and the
probe SHALL treat it as unavailable rather than starting a Dictation session that
will fail during Transcription. The finish-setup view SHALL distinguish this case
from a never-installed Engine, because the remedy differs — repairing a broken
install is not the same instruction as performing a first one.

When the resolved CLI is older
than the machine-readable output and therefore does not produce it, the probe
SHALL fall back to the previous prose marker rather than reporting a broken
install — the extension is distributed through the Raycast Store and cannot
assume the CLI on a given machine matches it.

A probe that cannot run at all SHALL continue to fail open, letting the CLI's own
guards report the real problem with a better message than the probe could.

#### Scenario: CLI present but engine not installed

- **WHEN** Maks starts dictation with the CLI installed but `kesha install` never run
- **THEN** a finish-setup view names `kesha install` before any recording toast appears

#### Scenario: Engine present, structured probe succeeds

- **GIVEN** the resolved CLI produces machine-readable status output and the Engine is installed
- **WHEN** Maks starts a Dictation session
- **THEN** the probe reports the Engine as available without inspecting any human-readable text
- **AND** recording starts without a finish-setup view

#### Scenario: Engine present but unusable

- **GIVEN** the Engine binary exists but cannot report its capabilities (corrupt or incompatible)
- **WHEN** Maks starts a Dictation session
- **THEN** the probe reports the Engine as unavailable despite it being present
- **AND** the finish-setup view names repairing the install, distinct from the never-installed wording
- **AND** no recording starts

#### Scenario: Older CLI without machine-readable status

- **GIVEN** the resolved CLI predates the machine-readable status output
- **WHEN** Maks starts a Dictation session with no Engine installed
- **THEN** the probe falls back to the prose marker and still renders the finish-setup view
- **AND** an installed Engine on that same older CLI still starts recording normally

#### Scenario: Probe cannot run

- **WHEN** the resolved CLI cannot be spawned or exits unexpectedly during the probe
- **THEN** the probe fails open and the Dictation session proceeds
- **AND** any real problem is reported by the CLI's own error path

> *Technical Note — sources: `raycast/src/lib/kesha-bin.ts::probeEngineAvailability`
> (`raycast/src/lib/kesha-bin.ts:166-181`), which today spawns `kesha status` and tests
> `stdout.includes("not installed")` (`:172`), returning the trimmed stderr as the hint.
> The structured path reads the Engine-presence boolean and hint from `kesha status
> --json` (see the `diagnostics` capability). `raycast/` is mirrored into
> `raycast/extensions`, so a change here needs a follow-up upstream sync.*

## Open Issues

- The fallback path means the prose marker `"not installed"` in `kesha status`
  stays a load-bearing string for as long as older CLIs are in the wild. There is
  no agreed point at which the fallback can be dropped, and nothing fails loudly
  if the marker is reworded while the fallback is still relied upon.
- The prose fallback cannot detect a present-but-unusable Engine: an older CLI's
  human output says "probe failed" on a line the marker match does not read, so on
  those CLIs a corrupt Engine still reaches recording and fails during
  Transcription. This matches today's behaviour and is not a regression, but it
  means the broken-Engine guarantee holds only on the structured path.
- The exact remedy for a corrupt Engine is unverified: `kesha install` has no
  documented force/repair flag, so what the finish-setup view should tell Maks to
  run — and whether a plain re-run of `kesha install` overwrites an existing
  binary — needs to be established during implementation.
