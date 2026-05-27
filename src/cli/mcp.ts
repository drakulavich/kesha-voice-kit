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
  },
});
