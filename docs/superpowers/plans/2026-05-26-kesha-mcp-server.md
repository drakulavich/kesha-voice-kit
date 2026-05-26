# kesha mcp — stdio MCP server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `kesha mcp` subcommand that runs a Model Context Protocol server over stdio, exposing `transcribe_audio`, `synthesize_speech`, and `list_voices` by orchestrating the existing `src/lib.ts` API.

**Architecture:** A thin citty command (`src/cli/mcp.ts`) wires stdio transport to a pure factory `createKeshaMcpServer()` (`src/mcp/server.ts`) that registers three tools (`src/mcp/tools.ts`) backed by small helpers for audio output (`src/mcp/audio-output.ts`) and voice listing (`src/mcp/voices.ts`). No Rust/engine changes — CLI-only release.

**Tech Stack:** Bun + TypeScript, `@modelcontextprotocol/sdk@^1.29.0` (+ `zod`), citty (existing), `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-26-kesha-mcp-server-design.md`

---

## SDK API reference (pinned to @modelcontextprotocol/sdk 1.29.0)

Use these exact imports and shapes everywhere below. Do **not** install
`@modelcontextprotocol/server` (that is the unreleased 2.0 alpha with a different API).

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
```

- `server.registerTool(name, { title?, description?, inputSchema?, outputSchema?, annotations? }, cb)`.
- `inputSchema` / `outputSchema` are a **ZodRawShape** — a plain object of zod fields,
  e.g. `{ path: z.string(), timestamps: z.boolean().optional() }` — **not** `z.object(...)`.
- Handler: `async (args, extra) => CallToolResult` where the result is
  `{ content: ContentBlock[], structuredContent?: object, isError?: boolean }`.
- `extra.signal` is an `AbortSignal`.
- `server.registerResource(name, uri | ResourceTemplate, config, readCallback)`.
- A resource-link content block: `{ type: "resource_link", uri, name, mimeType }`.
- Test pairing: `const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b);`
  then `const client = new Client({ name, version }); await client.connect(a);`
  then `await client.listTools()` / `await client.callTool({ name, arguments })`.

## File structure

| File | Responsibility |
|---|---|
| `src/cli/mcp.ts` | citty `mcpCommand`; builds the server, connects `StdioServerTransport`. No tool logic. |
| `src/mcp/server.ts` | `createKeshaMcpServer(): McpServer` — runs the temp sweep, registers the 3 tools. Pure factory. |
| `src/mcp/tools.ts` | `registerTools(server)` — the 3 tool schemas + handlers. |
| `src/mcp/audio-output.ts` | temp dir (`0700`), `allocAudioPath(format)`, `sweepOldAudio()`. |
| `src/mcp/voices.ts` | `parseVoiceLines(text)` (pure) + `listVoices()` (spawns engine). |
| `src/cli/dispatch.ts` | register `mcp: mcpCommand` in `SUBCOMMANDS`. |
| `tests/unit/mcp-*.test.ts` | unit + in-memory transport tests. |
| `tests/integration/mcp-e2e.test.ts` | TTS/ASR-dependent end-to-end (gated like say-e2e). |
| `README.md`, `package.json` | docs + CLI-only version bump. |

---

### Task 1: Dependency + command skeleton + handshake test

**Files:**
- Modify: `package.json` (dependencies)
- Create: `src/mcp/server.ts`
- Create: `src/cli/mcp.ts`
- Modify: `src/cli/dispatch.ts:11-30` (import + SUBCOMMANDS entry)
- Test: `tests/unit/mcp-server.test.ts`

- [ ] **Step 1: Add the dependency**

```bash
cd .worktrees/mcp-server
bun add @modelcontextprotocol/sdk@^1.29.0
# zod is a transitive peer; add it explicitly so imports are stable:
bun add zod
```
Expected: `package.json` `dependencies` gains `@modelcontextprotocol/sdk` and `zod`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/mcp-server.test.ts
import { describe, test, expect } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";

async function connect() {
  const server = createKeshaMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return { client, server };
}

describe("kesha mcp server", () => {
  test("handshake succeeds and lists the three tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_voices", "synthesize_speech", "transcribe_audio"]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/unit/mcp-server.test.ts`
Expected: FAIL — `createKeshaMcpServer` not found (module missing).

- [ ] **Step 4: Create the server factory (tools wired in later tasks)**

```ts
// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { packageVersion } from "../package-info";
import { sweepOldAudio } from "./audio-output";
import { registerTools } from "./tools";

export function createKeshaMcpServer(): McpServer {
  // Best-effort cleanup of stale synthesized audio from previous sessions.
  sweepOldAudio();
  const server = new McpServer({ name: "kesha-voice-kit", version: packageVersion });
  registerTools(server);
  return server;
}
```

Create stubs so this compiles now; real bodies land in later tasks:

```ts
// src/mcp/audio-output.ts  (stub — completed in Task 2)
export function sweepOldAudio(): void {}
```
```ts
// src/mcp/tools.ts  (stub — tools added in Tasks 4-6)
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export function registerTools(_server: McpServer): void {}
```

- [ ] **Step 5: Create the citty command**

```ts
// src/cli/mcp.ts
import { defineCommand } from "citty";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKeshaMcpServer } from "../mcp/server";

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description:
      "Run a Model Context Protocol server over stdio (transcribe_audio, synthesize_speech, list_voices). " +
      "Configure an MCP client with: { command: 'kesha', args: ['mcp'] }.",
  },
  async run() {
    // stdout is the JSON-RPC stream — nothing else may write to it.
    const server = createKeshaMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // server.connect keeps the process alive until stdin closes.
  },
});
```

- [ ] **Step 6: Register the subcommand**

In `src/cli/dispatch.ts`, add the import next to the others and the map entry:

```ts
import { mcpCommand } from "./mcp";
```
```ts
const SUBCOMMANDS: Record<string, CommandDef<any>> = {
  // ...existing entries...
  mcp: mcpCommand,
};
```

- [ ] **Step 7: Run the test to verify it fails differently / passes after Task 6**

Run: `bun test tests/unit/mcp-server.test.ts`
Expected now: FAIL on the tool-names assertion (no tools registered yet) — the
handshake itself succeeds. This test goes green at the end of Task 6. Keep it.

- [ ] **Step 8: Type-check + commit**

Run: `bunx tsc --noEmit` → Expected: PASS.
```bash
git add package.json bun.lock src/mcp/server.ts src/mcp/audio-output.ts src/mcp/tools.ts src/cli/mcp.ts src/cli/dispatch.ts tests/unit/mcp-server.test.ts
git commit -m "feat(mcp): add kesha mcp command skeleton + server factory (#473)"
```

---

### Task 2: Audio output helper (temp dir, alloc, sweep)

**Files:**
- Modify: `src/mcp/audio-output.ts`
- Test: `tests/unit/mcp-audio-output.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/mcp-audio-output.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, utimesSync, rmSync, statSync } from "fs";
import { join } from "path";
import { audioDir, allocAudioPath, sweepOldAudio } from "../../src/mcp/audio-output";

afterEach(() => {
  try { rmSync(audioDir(), { recursive: true, force: true }); } catch {}
});

describe("mcp audio-output", () => {
  test("allocAudioPath returns a unique path with the right extension", () => {
    const a = allocAudioPath("wav");
    const b = allocAudioPath("ogg-opus");
    expect(a.endsWith(".wav")).toBe(true);
    expect(b.endsWith(".ogg")).toBe(true);
    expect(a).not.toBe(b);
    expect(a.startsWith(audioDir())).toBe(true);
  });

  test("dir is created with 0700", () => {
    allocAudioPath("wav"); // creates the dir
    const mode = statSync(audioDir()).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("sweepOldAudio deletes files older than 24h, keeps fresh", () => {
    const dir = audioDir();
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "old.wav");
    const fresh = join(dir, "fresh.wav");
    writeFileSync(old, "x");
    writeFileSync(fresh, "y");
    const longAgo = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(old, longAgo, longAgo);
    sweepOldAudio();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/mcp-audio-output.test.ts`
Expected: FAIL — `audioDir`/`allocAudioPath` not exported.

- [ ] **Step 3: Implement**

```ts
// src/mcp/audio-output.ts
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";
import type { SayFormat } from "../synth";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function audioDir(): string {
  return join(tmpdir(), "kesha-mcp");
}

function extFor(format: SayFormat): string {
  switch (format) {
    case "ogg-opus":
      return "ogg";
    case "flac":
      return "flac";
    case "wav":
    default:
      return "wav";
  }
}

export function allocAudioPath(format: SayFormat): string {
  mkdirSync(audioDir(), { recursive: true, mode: 0o700 });
  return join(audioDir(), `${randomUUID()}.${extFor(format)}`);
}

export function sweepOldAudio(): void {
  const dir = audioDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir does not exist yet — nothing to sweep
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of entries) {
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    } catch {
      // race with another session or perms — best-effort, ignore
    }
  }
}
```
> Note: `mkdirSync(..., { mode: 0o700 })` is honored only on creation; the test runs
> against a fresh dir so the mode assertion holds. File mode `0600` is enforced in
> Task 6 when `say` has written the file (the engine creates it `0644`, so the
> handler `chmodSync(path, 0o600)` after synthesis).

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/mcp-audio-output.test.ts` → Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/audio-output.ts tests/unit/mcp-audio-output.test.ts
git commit -m "feat(mcp): temp audio dir, alloc, and 24h sweep (#473)"
```

---

### Task 3: Voice listing helper (pure parse + engine spawn)

**Files:**
- Create/Modify: `src/mcp/voices.ts`
- Test: `tests/unit/mcp-voices.test.ts`

The engine's `say --list-voices` prints one bare id per line. Map each to
`{ id, engine, lang }`.

- [ ] **Step 1: Write the failing test (pure parser)**

```ts
// tests/unit/mcp-voices.test.ts
import { describe, test, expect } from "bun:test";
import { parseVoiceLines } from "../../src/mcp/voices";

describe("parseVoiceLines", () => {
  test("maps ids to engine + lang", () => {
    const out = parseVoiceLines(
      "en-am_michael\nru-vosk-m02\nmacos-com.apple.eloquence.de-DE.Eddy\n\n",
    );
    expect(out).toEqual([
      { id: "en-am_michael", engine: "kokoro", lang: "en" },
      { id: "ru-vosk-m02", engine: "vosk", lang: "ru" },
      { id: "macos-com.apple.eloquence.de-DE.Eddy", engine: "avspeech", lang: "de-DE" },
    ]);
  });

  test("ignores blank lines and trims", () => {
    expect(parseVoiceLines("  en-am_adam  \n\n")).toEqual([
      { id: "en-am_adam", engine: "kokoro", lang: "en" },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/mcp-voices.test.ts`
Expected: FAIL — `parseVoiceLines` not found.

- [ ] **Step 3: Implement**

```ts
// src/mcp/voices.ts
import { getEngineBinPath } from "../engine";

export interface VoiceInfo {
  id: string;
  engine: "kokoro" | "vosk" | "avspeech" | "unknown";
  lang: string | null;
}

function engineFor(id: string): VoiceInfo["engine"] {
  if (id.startsWith("ru-vosk-")) return "vosk";
  if (id.startsWith("en-")) return "kokoro";
  if (id.startsWith("macos-")) return "avspeech";
  return "unknown";
}

function langFor(id: string): string | null {
  if (id.startsWith("en-")) return "en";
  if (id.startsWith("ru-vosk-")) return "ru";
  const m = id.match(/[a-z]{2}-[A-Z]{2}/);
  return m ? m[0] : null;
}

export function parseVoiceLines(text: string): VoiceInfo[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((id) => ({ id, engine: engineFor(id), lang: langFor(id) }));
}

export async function listVoices(): Promise<VoiceInfo[]> {
  const proc = Bun.spawn([getEngineBinPath(), "say", "--list-voices"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`engine list-voices failed (exit ${code}): ${err.trim()}`);
  }
  return parseVoiceLines(out);
}
```
> Confirm `getEngineBinPath` is exported from `src/engine.ts`; `src/cli/say.ts:135`
> already imports and uses it. If it lives elsewhere, import from the same module
> `say.ts` does.

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/mcp-voices.test.ts` → Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/voices.ts tests/unit/mcp-voices.test.ts
git commit -m "feat(mcp): voice-list parser + engine spawn helper (#473)"
```

---

### Task 4: `list_voices` tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Test: `tests/unit/mcp-list-voices.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/mcp-list-voices.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";

// list_voices spawns the real engine; this test runs only when TTS voices exist.
// Skip gracefully otherwise (mirrors say-e2e gating).
describe("list_voices tool", () => {
  test("returns structured voices", async () => {
    const server = createKeshaMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const res = await client.callTool({ name: "list_voices", arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { voices: Array<{ id: string; engine: string }> };
    expect(Array.isArray(sc.voices)).toBe(true);
    expect(sc.voices.length).toBeGreaterThan(0);
    expect(sc.voices[0]).toHaveProperty("engine");
  });
});
```
> If the CI runner has no engine installed, gate this file the same way
> `tests/integration/say-e2e.test.ts` gates on installed models (check a cache
> marker and `test.skip` when absent). Prefer placing engine-dependent specs under
> `tests/integration/`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/mcp-list-voices.test.ts`
Expected: FAIL — tool `list_voices` not registered (unknown tool error).

- [ ] **Step 3: Implement the tool registration**

```ts
// src/mcp/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listVoices } from "./voices";

export function registerTools(server: McpServer): void {
  server.registerTool(
    "list_voices",
    {
      title: "List voices",
      description: "List installed TTS voices with their engine and language.",
      inputSchema: {},
      outputSchema: {
        voices: z.array(
          z.object({
            id: z.string(),
            engine: z.enum(["kokoro", "vosk", "avspeech", "unknown"]),
            lang: z.string().nullable(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const voices = await listVoices();
      return {
        content: [{ type: "text", text: `${voices.length} voices installed.` }],
        structuredContent: { voices },
      };
    },
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/mcp-list-voices.test.ts` → Expected: PASS (or `skip` with no engine).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts tests/unit/mcp-list-voices.test.ts
git commit -m "feat(mcp): list_voices tool (#473)"
```

---

### Task 5: `transcribe_audio` tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Test: `tests/integration/mcp-e2e.test.ts` (engine-dependent), `tests/unit/mcp-transcribe-errors.test.ts`

- [ ] **Step 1: Write the failing error-path test (no engine needed)**

```ts
// tests/unit/mcp-transcribe-errors.test.ts
import { describe, test, expect } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";

async function call(name: string, args: object) {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(c);
  return client.callTool({ name, arguments: args });
}

describe("transcribe_audio errors", () => {
  test("missing file returns isError, never throws protocol error", async () => {
    const res = await call("transcribe_audio", { path: "/no/such/file.wav" });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("File not found");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/mcp-transcribe-errors.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement the tool (append inside `registerTools`)**

```ts
// add imports at top of src/mcp/tools.ts
import { existsSync } from "fs";
import { transcribe, transcribeWithTimestamps } from "../lib";

// inside registerTools(server), after list_voices:
server.registerTool(
  "transcribe_audio",
  {
    title: "Transcribe audio",
    description: "Transcribe a local audio file to text. Set timestamps for segment timings.",
    inputSchema: {
      path: z.string().describe("Absolute or relative path to a local audio file"),
      timestamps: z.boolean().optional().describe("Return per-segment start/end times"),
    },
    outputSchema: {
      text: z.string(),
      segments: z.array(
        z.object({
          text: z.string(),
          start: z.number(),
          end: z.number(),
          speaker: z.number().optional(),
        }),
      ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ path, timestamps }, extra) => {
    if (extra.signal?.aborted) {
      return { isError: true, content: [{ type: "text", text: "request cancelled" }] };
    }
    if (!existsSync(path)) {
      return { isError: true, content: [{ type: "text", text: `File not found: ${path}` }] };
    }
    try {
      if (timestamps) {
        const out = await transcribeWithTimestamps(path);
        return {
          content: [{ type: "text", text: out.text }],
          structuredContent: { text: out.text, segments: out.segments },
        };
      }
      const text = await transcribe(path);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: toToolError(err) }] };
    }
  },
);
```

Add this shared helper at the bottom of `src/mcp/tools.ts`:

```ts
function toToolError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Surface the existing fail-loud install hints unchanged; never auto-download.
  if (/not installed|install --tts|kesha install/i.test(msg)) return msg;
  return msg;
}
```

- [ ] **Step 4: Write the engine-dependent happy-path test**

```ts
// tests/integration/mcp-e2e.test.ts
import { describe, test, expect } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { existsSync } from "fs";
import { createKeshaMcpServer } from "../../src/mcp/server";

// Gate on an installed engine the same way say-e2e gates on models.
const FIXTURE = "rust/tests/fixtures/jfk.wav"; // pick an existing fixture in the repo
const hasEngine = existsSync(FIXTURE); // replace with the real installed-engine probe used by say-e2e

async function client() {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const cl = new Client({ name: "t", version: "0" });
  await cl.connect(c);
  return cl;
}

describe.if(hasEngine)("mcp e2e", () => {
  test("transcribe_audio returns non-empty text", async () => {
    const cl = await client();
    const res = await cl.callTool({ name: "transcribe_audio", arguments: { path: FIXTURE } });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text.length).toBeGreaterThan(0);
  });
});
```
> Replace `FIXTURE` + `hasEngine` with the exact fixture path and installed-engine
> probe that `tests/integration/say-e2e.test.ts` / `e2e-engine.test.ts` already use —
> read that file and mirror its gating so this never runs without an engine.

- [ ] **Step 5: Run tests**

Run: `bun test tests/unit/mcp-transcribe-errors.test.ts` → Expected: PASS.
Run: `bun test tests/integration/mcp-e2e.test.ts` → Expected: PASS (or skip without engine).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts tests/unit/mcp-transcribe-errors.test.ts tests/integration/mcp-e2e.test.ts
git commit -m "feat(mcp): transcribe_audio tool (#473)"
```

---

### Task 6: `synthesize_speech` tool (resource_link output)

**Files:**
- Modify: `src/mcp/tools.ts`
- Test: `tests/unit/mcp-say-errors.test.ts`, add a case to `tests/integration/mcp-e2e.test.ts`

- [ ] **Step 1: Write the failing error-path tests (no models needed)**

```ts
// tests/unit/mcp-say-errors.test.ts
import { describe, test, expect } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";

async function call(args: object) {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(c);
  return client.callTool({ name: "synthesize_speech", arguments: args });
}

describe("synthesize_speech errors", () => {
  test("rate out of range is isError", async () => {
    const res = await call({ text: "hi", rate: 9 });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/rate/i);
  });

  test("missing models fails loud with install hint and no download", async () => {
    // Point cache at an empty dir so models are absent.
    const prev = process.env.KESHA_CACHE_DIR;
    process.env.KESHA_CACHE_DIR = "/tmp/kesha-mcp-empty-" + Date.now();
    try {
      const res = await call({ text: "hello", voice: "en-am_michael" });
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0].text).toMatch(/install --tts|not installed/i);
    } finally {
      if (prev === undefined) delete process.env.KESHA_CACHE_DIR;
      else process.env.KESHA_CACHE_DIR = prev;
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/mcp-say-errors.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3a: Register a readable audio resource template (idiomatic MCP)**

Per the resolved design, synthesized audio is exposed as a real MCP resource so
clients can `resources/read` it — `registerResource` also auto-advertises the
`resources` capability. Add this near the top of `registerTools(server)` (before the
tools), using a custom `kesha-audio://{file}` scheme that maps to the temp dir:

```ts
// add imports at top of src/mcp/tools.ts
import { readFileSync } from "fs";
import { basename, join } from "path";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audioDir } from "./audio-output";

function mimeForExt(file: string): string {
  if (file.endsWith(".flac")) return "audio/flac";
  if (file.endsWith(".ogg")) return "audio/ogg";
  return "audio/wav";
}

// inside registerTools(server), FIRST:
server.registerResource(
  "synthesized-audio",
  new ResourceTemplate("kesha-audio://{file}", { list: undefined }),
  { title: "Synthesized audio", description: "WAV/OGG/FLAC produced by synthesize_speech." },
  async (uri, { file }) => {
    // `file` is the basename only; reject anything that escapes the temp dir.
    const name = basename(String(file));
    const path = join(audioDir(), name);
    const bytes = readFileSync(path); // throws if absent → surfaced as resource error
    return {
      contents: [
        { uri: uri.href, mimeType: mimeForExt(name), blob: bytes.toString("base64") },
      ],
    };
  },
);
```

- [ ] **Step 3b: Implement the tool (append inside `registerTools`)**

```ts
// add imports at top of src/mcp/tools.ts
import { chmodSync, statSync } from "fs";
import { say, type SayFormat } from "../synth";
import { allocAudioPath } from "./audio-output";

// inside registerTools(server), after transcribe_audio:
server.registerTool(
  "synthesize_speech",
  {
    title: "Synthesize speech",
    description:
      "Synthesize speech from text into an audio file and return a resource link. " +
      "Omit voice to auto-route by language (male defaults en-am_michael / ru-vosk-m02).",
    inputSchema: {
      text: z.string().min(1).describe("Text to speak"),
      voice: z.string().optional().describe("Voice id, e.g. en-am_michael"),
      rate: z.number().optional().describe("Speaking rate 0.5–2.0"),
      format: z.enum(["wav", "ogg-opus", "flac"]).optional().describe("Output format (default wav)"),
    },
    outputSchema: {
      uri: z.string(),
      path: z.string(),
      format: z.string(),
      voice: z.string(),
      bytes: z.number(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ text, voice, rate, format }, extra) => {
    if (extra.signal?.aborted) {
      return { isError: true, content: [{ type: "text", text: "request cancelled" }] };
    }
    if (rate !== undefined && (rate < 0.5 || rate > 2.0)) {
      return { isError: true, content: [{ type: "text", text: `rate ${rate} out of range (0.5–2.0)` }] };
    }
    const fmt: SayFormat = format ?? "wav";
    const outPath = allocAudioPath(fmt);
    try {
      await say({ text, voice, rate, format: fmt, out: outPath });
      chmodSync(outPath, 0o600); // engine writes 0644; restrict (shared /tmp)
      const bytes = statSync(outPath).size;
      const file = basename(outPath);
      const uri = `kesha-audio://${file}`; // resolves via the registered resource template
      const mimeType = fmt === "wav" ? "audio/wav" : fmt === "flac" ? "audio/flac" : "audio/ogg";
      const resolvedVoice = voice ?? "(auto)";
      return {
        content: [
          { type: "resource_link", uri, name: file, mimeType },
          { type: "text", text: `Synthesized ${bytes} bytes (voice=${resolvedVoice}, format=${fmt}); read it via resources/read ${uri}.` },
        ],
        structuredContent: { uri, path: outPath, format: fmt, voice: resolvedVoice, bytes },
      };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: toToolError(err) }] };
    }
  },
);
```

- [ ] **Step 4: Add the engine-dependent happy path to `tests/integration/mcp-e2e.test.ts`**

```ts
// inside describe.if(hasEngine)("mcp e2e", ...)
test("synthesize_speech returns a readable resource_link to a valid file", async () => {
  const cl = await client();
  const res = await cl.callTool({
    name: "synthesize_speech",
    arguments: { text: "Hello world", voice: "en-am_michael", format: "wav" },
  });
  expect(res.isError).toBeFalsy();
  const link = (res.content as Array<{ type: string; uri: string }>).find((c) => c.type === "resource_link");
  expect(link?.uri.startsWith("kesha-audio://")).toBe(true);
  const sc = res.structuredContent as { uri: string; path: string; bytes: number };
  const { existsSync, statSync } = await import("fs");
  expect(existsSync(sc.path)).toBe(true);
  expect((statSync(sc.path).mode & 0o777)).toBe(0o600);
  expect(sc.bytes).toBeGreaterThan(1000);
  // resources/read must return the audio bytes as a base64 blob.
  const read = await cl.readResource({ uri: sc.uri });
  const blob = (read.contents[0] as { blob?: string }).blob;
  expect(typeof blob).toBe("string");
  expect(Buffer.from(blob as string, "base64").length).toBe(sc.bytes);
});
```
> This test needs TTS models (+ g2p) staged exactly like
> `tests/integration/say-e2e.test.ts::beforeAll` — read that file and reuse its
> cache/g2p staging so synthesis does not fail with `g2p: G2P model not installed`.

- [ ] **Step 5: Run tests**

Run: `bun test tests/unit/mcp-say-errors.test.ts` → Expected: PASS.
Run: `bun test tests/unit/mcp-server.test.ts` → Expected: PASS now (all 3 tools registered).
Run: `bun test tests/integration/mcp-e2e.test.ts` → Expected: PASS (or skip without models).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts tests/unit/mcp-say-errors.test.ts tests/integration/mcp-e2e.test.ts
git commit -m "feat(mcp): synthesize_speech tool with resource_link output (#473)"
```

---

### Task 7: stdout-discipline test + conformance handshake

**Files:**
- Test: `tests/unit/mcp-stdout-discipline.test.ts`

This guards the #1 stdio footgun: any stray stdout byte corrupts the JSON-RPC stream.

- [ ] **Step 1: Write the test (spawn the real CLI, drive raw JSON-RPC over stdio)**

```ts
// tests/unit/mcp-stdout-discipline.test.ts
import { describe, test, expect } from "bun:test";

// Spawn `kesha mcp` and speak minimal JSON-RPC; assert every stdout line is a
// valid JSON-RPC frame (no logs, no progress text leaked to stdout).
describe("mcp stdout discipline", () => {
  test("stdout carries only JSON-RPC frames", async () => {
    const proc = Bun.spawn(["bun", "bin/kesha.js", "mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    };
    const listTools = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    proc.stdin.write(JSON.stringify(initialize) + "\n");
    proc.stdin.write(JSON.stringify(listTools) + "\n");
    await proc.stdin.flush();

    // Read for a short window, then terminate.
    const reader = proc.stdout.getReader();
    let buf = "";
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      if (buf.includes('"id":2')) break;
    }
    proc.kill();

    const lines = buf.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Each non-empty stdout line MUST parse as JSON-RPC — no stray logs.
      const obj = JSON.parse(line);
      expect(obj.jsonrpc).toBe("2.0");
    }
  });
});
```
> Confirm the CLI entrypoint path (`bin/kesha.js`) and that `bun bin/kesha.js mcp`
> runs locally; adjust to the repo's actual entry if different. The test both proves
> the handshake works end-to-end (conformance) and that stdout is clean.

- [ ] **Step 2: Run to verify it passes**

Run: `bun test tests/unit/mcp-stdout-discipline.test.ts`
Expected: PASS. If it FAILS because a `console.log` leaked onto stdout, fix the
offending call to use `console.error`/`log.*` (stderr) — do not silence the test.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/mcp-stdout-discipline.test.ts
git commit -m "test(mcp): stdout-discipline + raw JSON-RPC conformance (#473)"
```

---

### Task 8: Docs, version bump, draft PR

**Files:**
- Modify: `README.md`
- Modify: `package.json` (CLI-only version bump)

- [ ] **Step 1: Add a README section**

Insert after the Integrations section (find `## Integrations`):

````markdown
## MCP server

`kesha mcp` runs a local Model Context Protocol server over stdio, exposing
`transcribe_audio`, `synthesize_speech`, and `list_voices` to any MCP client.
Models are never auto-downloaded — tools fail with a `kesha install` / `kesha install --tts`
hint when missing.

Add to your client config:

```json
{ "mcpServers": { "kesha": { "command": "kesha", "args": ["mcp"] } } }
```

- **Claude Desktop:** `claude_desktop_config.json`
- **Claude Code:** `claude mcp add kesha -- kesha mcp`
- **Cursor:** `.cursor/mcp.json`

If a tool returns "models not installed", run `kesha install` (ASR) or
`kesha install --tts` (TTS) once, then retry.
````

- [ ] **Step 2: CLI-only version bump**

Bump only `package.json#version` (patch). Do **NOT** touch `keshaEngine.version`
or `rust/Cargo.toml` — this is pure orchestration of existing engine commands.

Run: `bun .github/scripts/check-versions.ts` → Expected: PASS (CLI may lead engine).

- [ ] **Step 3: Full gate**

Run: `bun test && bunx tsc --noEmit` → Expected: PASS.

- [ ] **Step 4: Commit, push, open draft PR**

```bash
git add README.md package.json
git commit -m "docs(mcp): README usage + CLI-only version bump (#473)"
git push -u origin feat/mcp-server
gh pr create --draft --base main --head feat/mcp-server \
  --title "feat: kesha mcp stdio server" \
  --body "$(cat <<'BODY'
## Summary
- Adds `kesha mcp` — a local stdio MCP server exposing transcribe_audio, synthesize_speech, list_voices.
- Pure Bun/TS orchestration of src/lib.ts; new dep @modelcontextprotocol/sdk + zod. No engine/Rust changes.

Closes #473

## Test plan
- [ ] bun test && bunx tsc --noEmit
- [ ] In-memory transport: tools/list + each tool
- [ ] Missing-models path returns isError + install hint, no download
- [ ] stdout-discipline test green (no stray stdout)
- [ ] Manually connect Claude Code (`claude mcp add kesha -- kesha mcp`) and call a tool
BODY
)"
```

---

## Follow-ups (out of scope for this PR)

- Mid-flight cancellation: thread `AbortSignal` into the lib's internal `Bun.spawn`
  (TS-only) so an aborted request kills the engine subprocess. Open a follow-up issue.
- Progress notifications (`_meta.progressToken`) for long transcriptions.
- Optional `detect_language` and `status` tools (deferred from the ticket's list).

## Self-review

- **Spec coverage:** 3 tools (T4-T6) ✓; full `registerResource` + `resources` capability
  via a `kesha-audio://{file}` template, `resource_link` in tool output, and a
  `resources/read` test (T6 Step 3a + e2e) ✓; temp dir 0700 + 0600 + sweep (T2, T6) ✓;
  never-download error contract (T5/T6 isError + toToolError) ✓; stdout discipline (T7) ✓;
  conformance handshake (T7) ✓; annotations + outputSchema (T4-T6) ✓; CLI-only release (T8) ✓;
  README per-client (T8) ✓; cancellation pre-flight (T5/T6 `extra.signal.aborted`) ✓,
  mid-flight deferred (Follow-ups) ✓.
- **Resource security:** the template read callback uses `basename()` on the `{file}`
  param so a malicious `kesha-audio://../../etc/passwd` cannot escape the temp dir.
- **Placeholder scan:** the two engine-dependent gates (T4, T5) intentionally say
  "mirror say-e2e gating" with the exact reference file named — the implementer must read
  that file for the precise probe. No other TODOs.
- **Type consistency:** `SayFormat` reused from `src/synth.ts`; `VoiceInfo`, `allocAudioPath`,
  `sweepOldAudio`, `createKeshaMcpServer`, `registerTools`, `parseVoiceLines`, `listVoices`,
  `toToolError` names are consistent across tasks.
