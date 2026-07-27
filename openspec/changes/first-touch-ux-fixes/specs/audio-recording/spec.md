## ADDED Requirements

### Requirement: Recording without an installed engine fails with an install hint
`kesha record` SHALL check that the engine binary is installed before spawning it. When the engine is missing, the CLI SHALL print a human-readable error naming the missing backend and the exact install command, and exit 1. A raw runtime stack trace MUST never be the user-facing output for this condition.

#### Scenario: record before kesha install
- **WHEN** a user runs `kesha record --out x.wav` and the engine binary is not installed
- **THEN** stderr contains "No recording backend is installed" followed by the install hint, the process exits 1, and no stack trace is printed
