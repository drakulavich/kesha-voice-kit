import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerTools(server: McpServer): void {
  server.tool(
    "transcribe_audio",
    "Transcribe speech from an audio file to text.",
    { audio_path: z.string().describe("Absolute path to the audio file to transcribe.") },
    async () => ({ content: [{ type: "text" as const, text: "" }] }),
  );

  server.tool(
    "synthesize_speech",
    "Synthesize speech from text and return the path to the output WAV file.",
    {
      text: z.string().describe("Text to synthesize."),
      voice: z.string().optional().describe("Voice ID (e.g. en-am_michael, ru-vosk-m02)."),
    },
    async () => ({ content: [{ type: "text" as const, text: "" }] }),
  );

  server.tool(
    "list_voices",
    "List available TTS voices.",
    {},
    async () => ({ content: [{ type: "text" as const, text: "" }] }),
  );
}
