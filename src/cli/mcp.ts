import { defineCommand } from "citty";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKeshaMcpServer } from "../mcp/server";

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description:
      "Run a Model Context Protocol server over stdio (transcribe_audio, synthesize_speech, list_voices, list_languages). " +
      "Configure an MCP client with: { command: 'kesha', args: ['mcp'] }.",
  },
  async run() {
    const server = createKeshaMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // The SDK transport never watches for EOF, so a client that died mid-call left the engine running (exploratory S7-2).
    process.stdin.once("end", () => void server.close());
  },
});
