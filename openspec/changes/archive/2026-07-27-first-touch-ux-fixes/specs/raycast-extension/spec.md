## ADDED Requirements

### Requirement: Not-found guidance works for users without bun
When the kesha CLI cannot be resolved, the extension's guidance SHALL present a Homebrew-first install path, mention the bun alternative, include the mandatory `kesha install` follow-up step, and demote the probed-paths listing to a secondary troubleshooting line.

#### Scenario: Store user without the CLI
- **WHEN** the extension cannot find the kesha binary
- **THEN** the error view shows numbered setup steps (install CLI, run `kesha install`) understandable without prior knowledge of bun

### Requirement: Error views are actionable
Every error state SHALL render an ActionPanel with at least: copy the error text, open extension preferences, and open the setup guide.

#### Scenario: any error state
- **WHEN** the extension shows an error Detail
- **THEN** the user can copy the error, open preferences, or open the setup guide without leaving Raycast

### Requirement: Setup problems surface before recording
Before entering the recording state, the extension SHALL probe the resolved CLI (version/engine availability) and, on failure, render a dedicated finish-setup view naming the exact remaining command instead of starting a recording that cannot succeed.

#### Scenario: CLI present but engine not installed
- **WHEN** the user starts dictation with the CLI installed but `kesha install` never run
- **THEN** a finish-setup view names `kesha install` before any recording toast appears

### Requirement: Missing microphone input is reported early
When the signal meter delivers no sample within a short window (~8 s) of recording start, the extension SHALL surface microphone-permission guidance as a non-blocking warning while recording continues — a meter failure alone MUST NOT abort a session that may still be capturing audio. An unavailable meter MUST NOT disarm the silence auto-stop, so a session without input ends at the idle stop instead of the maximum duration.

#### Scenario: mic permission denied
- **WHEN** macOS denies microphone access and the meter reports unavailable
- **THEN** within ~8 s the user sees guidance to grant Raycast microphone access, recording continues, and the session ends at the silence auto-stop with the silent-recording error instead of running to the max duration
