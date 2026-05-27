import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { packageVersion } from "../package-info";
import { sweepOldAudio } from "./audio-output";
import { registerTools } from "./tools";

export function createKeshaMcpServer(): McpServer {
  sweepOldAudio();
  const server = new McpServer({ name: "kesha-voice-kit", version: packageVersion });
  registerTools(server);
  return server;
}
