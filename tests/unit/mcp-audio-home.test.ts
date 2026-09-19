import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { describeJson, saveEngineEnv } from "../helpers/fake-engine";
import { tempDir } from "../helpers/temp-dir";

const skipOnWin32 = process.platform === "win32" ? test.skip : test;

function sayingEngine(dir: string): string {
  const binPath = join(dir, "kesha-engine");
  writeFileSync(
    binPath,
    `#!/bin/sh
if [ "$1" = "describe" ]; then
  printf '%s\\n' '${describeJson({ features: ["tts"] })}'
  exit 0
fi
if [ "$1" = "say" ]; then
  cat > /dev/null
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--out" ]; then printf 'RIFF' > "$a"; fi
    prev="$a"
  done
  exit 0
fi
exit 2
`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("MCP audio under KESHA_HOME (openspec state-directories)", () => {
  skipOnWin32("synthesized audio lands in <home>/mcp-audio, not the temp directory", async () => {
    const dir = tempDir("kesha-mcp-home-");
    const home = join(dir, "state");
    const restore = saveEngineEnv();
    process.env.KESHA_HOME = home;
    process.env.KESHA_ENGINE_BIN = sayingEngine(dir);
    try {
      const server = createKeshaMcpServer();
      const [c, s] = InMemoryTransport.createLinkedPair();
      await server.connect(s);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(c);
      const res = await client.callTool({
        name: "synthesize_speech",
        arguments: { text: "hello", voice: "en-am_michael" },
      });
      const { path } = res.structuredContent as { path: string };
      expect(path.startsWith(join(home, "mcp-audio") + "/")).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, "mcp-audio")).mode & 0o777).toBe(0o700);
      expect(readdirSync(home)).toEqual(["mcp-audio"]);
    } finally {
      restore();
    }
  });
});
