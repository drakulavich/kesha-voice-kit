import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listVoices } from "./voices";

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
        content: [{ type: "text" as const, text: `${voices.length} voices installed.` }],
        structuredContent: { voices },
      };
    },
  );
}
