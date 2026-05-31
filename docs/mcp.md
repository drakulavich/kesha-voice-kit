# MCP server

`kesha mcp` runs a local Model Context Protocol server over stdio, exposing
`transcribe_audio`, `synthesize_speech`, `list_voices`, and `list_languages` to
any MCP client. Models are never auto-downloaded — tools fail with a
`kesha install` / `kesha install --tts` hint when missing.

Add to your client config:

```json
{ "mcpServers": { "kesha": { "command": "kesha", "args": ["mcp"] } } }
```

Claude Desktop users can place the same JSON in `claude_desktop_config.json`.

<details>
<summary>Claude Code</summary>

```bash
claude mcp add kesha -- kesha mcp
```

</details>

<details>
<summary>Codex</summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.kesha]
command = "kesha"
args = ["mcp"]
```

</details>

<details>
<summary>Gemini CLI</summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "kesha": {
      "command": "kesha",
      "args": ["mcp"]
    }
  }
}
```

</details>

<details>
<summary>Cursor</summary>

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "kesha": {
      "command": "kesha",
      "args": ["mcp"]
    }
  }
}
```

</details>

If a tool returns "models not installed", run `kesha install` (ASR) or
`kesha install --tts` (TTS) once, then retry.
