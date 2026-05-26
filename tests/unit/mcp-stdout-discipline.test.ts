import { describe, test, expect } from "bun:test";

describe("mcp stdout discipline", () => {
  test("stdout carries only JSON-RPC frames", async () => {
    // process.execPath is the absolute path to the running bun binary — a bare
    // "bun" fails uv_spawn on Windows (no PATH/.exe resolution). import.meta.dir
    // (Bun-native, absolute) anchors the repo root so this works regardless of cwd.
    const proc = Bun.spawn([process.execPath, "bin/kesha.js", "mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: `${import.meta.dir}/../..`,
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

    const reader = proc.stdout.getReader();
    let buf = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      // Both responses received once we see id:2 in the buffer
      if (buf.includes('"id":2')) break;
    }
    proc.kill();

    const lines = buf.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        throw new Error(`Non-JSON line leaked to stdout (stdout is the JSON-RPC stream): ${JSON.stringify(line)}`);
      }
      expect((obj as Record<string, unknown>).jsonrpc).toBe("2.0");
    }
  });
});
