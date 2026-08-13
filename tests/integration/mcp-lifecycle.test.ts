import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { waitForPidExit, waitForPidFile } from "../helpers/process";

const DEFAULT_CWD = import.meta.dir + "/../..";

function createListVoicesHangEngine(dir: string, enginePidPath: string): string {
  const enginePath = join(dir, "kesha-engine");
  writeFileSync(
    enginePath,
    `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "--capabilities-json") {
  console.log(JSON.stringify({ protocolVersion: 3, backend: "fake", features: ["tts"] }));
  process.exit(0);
}
if (args[0] === "say" && args[1] === "--list-voices") {
  await Bun.write(${JSON.stringify(enginePidPath)}, String(process.pid));
  await new Promise(() => {});
}
console.error("unexpected fake engine args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(enginePath, 0o755);
  return enginePath;
}

// The MCP server is a long-lived stdio process: an unregistered list_voices spawn
// would leave the Engine to be reaped by the shell, outliving the request that
// created it, and no SIGINT handler would terminate it (#939).
describe("MCP server lifecycle", () => {
  test("interrupting the server terminates a list_voices Engine spawn", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "kesha-mcp-lifecycle-"));
    const enginePidPath = join(dir, "engine.pid");
    const enginePath = createListVoicesHangEngine(dir, enginePidPath);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", "src/cli-entry.ts", "mcp"],
      cwd: DEFAULT_CWD,
      env: {
        ...(process.env as Record<string, string>),
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        HOME: dir,
        KESHA_CACHE_DIR: join(dir, "cache"),
        KESHA_ENGINE_BIN: enginePath,
      },
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);

    // list_voices spawns the hanging Engine and never resolves; the interrupt below
    // is what ends it. Swallow the transport-closed rejection that the interrupt causes.
    void client.callTool({ name: "list_voices", arguments: {} }).catch(() => {});

    const enginePid = await waitForPidFile(enginePidPath);
    const serverPid = transport.pid;
    expect(serverPid).not.toBeNull();
    process.kill(serverPid!, "SIGINT");

    expect(await waitForPidExit(enginePid)).toBe(true);
    await transport.close().catch(() => {});
  }, 30_000);
});
