## ADDED Requirements

### Requirement: Directory arguments are rejected before work starts
When a positional argument is a directory, the CLI SHALL print `<path>: is a directory (expected an audio file)` and exit 1 before any progress output or engine spawn.

#### Scenario: passing a directory
- **WHEN** a user runs `kesha /tmp`
- **THEN** the CLI prints the is-a-directory message, exits 1, and no progress bar or engine invocation occurs

### Requirement: Unknown commands suggest near misses
When the first positional token is not a file and not a known subcommand, the CLI SHALL suggest the closest subcommand name when one is within edit distance, and for near-misses of "transcribe" SHALL additionally state that transcription is invoked by passing the audio path directly.

#### Scenario: typo of a subcommand
- **WHEN** a user runs `kesha statsu`
- **THEN** the output suggests `stats`

#### Scenario: typo of transcribe
- **WHEN** a user runs `kesha transcrib`
- **THEN** the output explains transcription is invoked as `kesha <audio-file>` in addition to the existing file hint
