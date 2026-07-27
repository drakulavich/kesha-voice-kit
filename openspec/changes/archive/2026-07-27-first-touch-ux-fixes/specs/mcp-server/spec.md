## ADDED Requirements

### Requirement: Voice listing tools return install hints when the engine is missing
`list_voices` and `list_languages` SHALL detect a missing engine before spawning and return a structured tool error whose message names the install command, matching the behavior `synthesize_speech` already has.

#### Scenario: list_voices before kesha install
- **WHEN** an MCP client calls `list_voices` and the engine binary is not installed
- **THEN** the tool returns `isError` with a message containing "kesha-engine not installed" and the install command, not a raw spawn exception

### Requirement: transcribe_audio path contract
The `transcribe_audio` tool SHALL document that paths resolve against the MCP server process's working directory and SHALL direct callers to pass absolute paths; when a relative path does not exist, the error message SHALL state the resolution rule.

#### Scenario: relative path from a GUI-launched client
- **WHEN** a client passes `./audio.wav` and the file does not exist relative to the server cwd
- **THEN** the error explains that relative paths resolve against the server working directory and recommends an absolute path
