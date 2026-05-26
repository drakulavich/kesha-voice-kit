# `kesha mcp` — Local MCP stdio server (design)

> Spec for [#473](https://github.com/drakulavich/kesha-voice-kit/issues/473).
> Reviewed against MCP protocol idioms, spec conformance, and quality/DX
> (simulated cohort: MCP creators + maintainer + test/DevRel). v1 is
> **stdio/local only** — no remote/HTTP transport.

## Goal

Ship a `kesha mcp` subcommand that runs a Model Context Protocol server over
**stdio**, wrapping the existing engine via the public API in `src/lib.ts`, so any
local MCP client (Claude Desktop/Code, Cursor, OpenClaw) can call kesha's speech
tools. Pure Bun/TypeScript — no new Rust, no engine changes.

## Non-goals (v1)

- No HTTP/SSE/remote transport.
- No install/download tool (models are never auto-fetched — see Constraints).
- No `out` / caller-controlled write path (security — see Tools › synthesize_speech).
- No progress notifications (cancellation **is** in scope; progress is a follow-up).

## Architecture

```
MCP client (Claude Desktop/Code, Cursor, OpenClaw)
   │  stdio · JSON-RPC 2.0
   ▼
src/cli/mcp.ts          citty defineCommand({name:"mcp"}); run() builds the server,
   │                    wires StdioServerTransport, await server.connect(transport).
   │                    THIN — no tool logic here.
   ▼
src/mcp/server.ts       createKeshaMcpServer(): McpServer
   │                    - registers the 3 tools + 1 resource template
   │                    - runs the temp-dir sweep on startup
   │                    - pure factory, no transport → unit-testable
   ├── src/mcp/tools.ts        zod input schemas + handlers for the 3 tools
   ├── src/mcp/audio-output.ts temp-dir resolve, 24h sweep, resource registration
   └── src/mcp/voices.ts       parse `kesha-engine say --list-voices` → structured list
        │
        ▼
   src/lib.ts           transcribe / transcribeWithTimestamps / say / (voices helper)
        ▼
   kesha-engine subprocess (existing — unchanged)
```

### Why these boundaries

- `src/cli/mcp.ts` only knows about transports; `createKeshaMcpServer()` only knows
  about tools. Tests drive the factory through the SDK's in-memory transport without
  spawning a process. This mirrors the repo's existing pattern of keeping the
  testable contract out of the citty `run` handler (`src/cli/main.ts`).
- `audio-output.ts` and `voices.ts` are small, single-purpose, independently testable.

## Dependency

Add **`@modelcontextprotocol/sdk`** (pulls in `zod` for tool input schemas). Both are
pure JS and run on Bun. This is the **only** new runtime dependency.

## MCP server identity & capabilities

- `new McpServer({ name: "kesha-voice-kit", version: <package.json#version> })`.
- Declare capabilities: **`tools`** and **`resources`** (the latter for synthesized
  audio). Do not declare prompts/sampling.
- The SDK negotiates `protocolVersion` during `initialize`; the conformance test
  (below) asserts a successful handshake at the negotiated version.

## Tools (3)

All tools that emit `structuredContent` MUST also declare an `outputSchema` and
include a human-readable text fallback in `content` (spec requirement). All carry
annotations so clients can reason about auto-approval.

### 1. `transcribe_audio`
- **Annotations:** `readOnlyHint: true`, `openWorldHint: false`.
- **Input (zod):** `{ path: string, timestamps?: boolean = false }`.
- **Handler:**
  - If `!existsSync(path)` → `isError` result: `File not found: <path>`.
  - `timestamps === false` → `transcribe(path)` → text content = transcript.
  - `timestamps === true` → `transcribeWithTimestamps(path)` →
    `structuredContent: { text, language, segments: [{ text, start, end, speaker? }] }`
    plus `content` text = the transcript.
- **outputSchema (timestamps variant):** `{ text: string, language: string, segments: Array<{ text: string, start: number, end: number, speaker?: string }> }`.

### 2. `synthesize_speech`
- **Annotations:** `readOnlyHint: false`, `openWorldHint: false`.
- **Input (zod):** `{ text: string, voice?: string, rate?: number (0.5–2.0), format?: "wav" | "ogg-opus" | "flac" = "wav" }`.
  - **No `out` argument** — eliminating the model-controlled arbitrary-write
    primitive. Output always goes to the managed temp dir.
  - Omitted `voice` → lib auto-routing picks the **male** default
    (`en-am_michael` / `ru-vosk-m02`). Voice defaults are unchanged.
  - `rate` out of `[0.5, 2.0]` → `isError` with a clear message (do not clamp silently).
- **Handler:** resolve a temp path `audio-output.ts::allocPath(format)`, call
  `say({ text, voice, rate, format, out: path })`, register the file as a resource,
  return:
  - `content`: a `resource_link` to the `file://` URI **plus** a one-line text summary
    (`Synthesized N bytes to <uri> (voice=<id>, format=<fmt>)`).
  - `structuredContent: { uri, path, format, voice, bytes }` (path retained for
    local convenience; `uri` is the canonical handle).
- **outputSchema:** `{ uri: string, path: string, format: string, voice: string, bytes: number }`.

### 3. `list_voices`
- **Annotations:** `readOnlyHint: true`, `openWorldHint: false`.
- **Input:** none.
- **Handler:** `voices.ts` spawns the **existing** `kesha-engine say --list-voices`
  (same path `src/cli/say.ts:133` already uses — no new engine subcommand), parses
  `identifier|language|name` lines into structured records.
  `structuredContent: { voices: [{ id, lang, name, engine }] }` where `engine` is
  derived from the id prefix (`en-*`→kokoro, `ru-vosk-*`→vosk, `macos-*`→avspeech).
- **outputSchema:** `{ voices: Array<{ id: string, lang: string, name: string, engine: string }> }`.

## Audio output lifecycle (`audio-output.ts`)

- Dir: `join(tmpdir(), "kesha-mcp")`, created on demand with mode `0700`.
- Files: `<uuid>.<ext>` written with mode `0600` (audio may be sensitive; shared
  `/tmp` is multi-user readable otherwise).
- **Startup sweep:** `createKeshaMcpServer()` deletes files in that dir older than
  24h (best-effort; ignore unlink races). Bounds disk use without deleting paths the
  current session just returned.
- **Resource registration:** each synthesized file is registered so the client can
  `resources/read` it via its `file://` URI. The `resource_link` returned by
  `synthesize_speech` points at that URI.

## Error & download contract (hard constraint)

Tool handlers translate known failures into **tool execution errors**
(`{ isError: true, content: [text] }`), never JSON-RPC protocol errors, and
**never trigger a download**:

| Failure | Message |
|---|---|
| TTS models missing (`SayError` / missing-model) | ``TTS models not installed — run `kesha install --tts` `` |
| ASR engine/models missing | ``engine not installed — run `kesha install` `` |
| File not found / bad voice / rate out of range | clear, specific isError text |

This mirrors `kesha say`'s existing fail-loud behavior. No install/download tool is
exposed. The missing-models path is covered by a dedicated test that also asserts
**no network/download was attempted**.

## stdout discipline (P0 correctness)

stdio MCP uses **stdout for the JSON-RPC stream**. Any stray byte on stdout corrupts
every message.

- All kesha lib calls run with their existing `silent: true` path (transcribe already
  does this); `say` writes audio to a file, not stdout.
- Any diagnostics go to **stderr only**.
- **Test:** capture stdout during a full tools/list + tools/call cycle and assert it
  contains only well-formed JSON-RPC frames (no progress text, no logs).

## Cancellation

Long transcriptions must honor `notifications/cancelled`: the handler wires the
request's `AbortSignal` (provided by the SDK) to abort the underlying engine
subprocess. (Progress notifications via `_meta.progressToken` are deferred to a
follow-up issue.)

## Testing

- **Unit (in-memory linked transport, no process spawn):**
  - `tools/list` returns exactly the 3 tools with the declared input/output schemas
    and annotations.
  - `transcribe_audio` on a repo fixture → expected transcript; `timestamps: true`
    → segments + language present.
  - `list_voices` → non-empty, well-formed records.
  - `synthesize_speech` on a known voice → returns a `resource_link`; the referenced
    file exists, is a valid WAV, and is `resources/read`-able.
- **Conformance:** one real handshake test (`initialize` → `tools/list` →
  `tools/call`) over a paired transport to catch capability/negotiation regressions.
- **Negative paths:** missing models → `isError` + install hint + **no download**;
  missing file; `rate` out of range; oversized/empty `text`.
- **Unit:** `audio-output.ts` sweep deletes >24h files, keeps fresh; file perms `0600`.
- **stdout discipline test** (above).
- TTS-dependent tests follow the existing `tests/integration/say-e2e.test.ts`
  gating (real cache + staged g2p models).
- Gate: `bun test && bunx tsc --noEmit`.

## Release & packaging

- **CLI-only release.** Bump only `package.json#version`. Do **not** touch
  `package.json#keshaEngine.version` or `rust/Cargo.toml` — the server only
  orchestrates existing engine subcommands/output contracts. If implementation reveals
  a need for a new engine subcommand/flag/output, **stop** — that reclassifies this as
  an engine release; flag it rather than bumping silently.
- Cut the `vX.Y.Z-cli` marker per the CLAUDE.md CLI-only release runbook after merge.

## Docs

- README section: what `kesha mcp` is + per-client config:
  - Claude Desktop (`claude_desktop_config.json`), Claude Code, Cursor — each:
    `{ "command": "kesha", "args": ["mcp"] }`.
  - Troubleshooting: if a tool returns "models not installed", run `kesha install` /
    `kesha install --tts`; the error renders as actionable text in the client UI.

## Process

Work in the worktree `.worktrees/mcp-server` (branch `feat/mcp-server`) from fresh
`origin/main`. `#473` is labeled `WIP`. Open a **draft** PR with `Closes #473` in the
body. Drive the Greptile + CI gates per CLAUDE.md before marking ready.
