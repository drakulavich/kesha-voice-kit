import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "fs";
import { transcribe, transcribeWithTimestamps } from "../lib";
import { listVoices } from "./voices";

export function registerTools(server: McpServer): void {
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
        return { isError: true, content: [{ type: "text" as const, text: "request cancelled" }] };
      }
      if (!existsSync(path)) {
        return { isError: true, content: [{ type: "text" as const, text: `File not found: ${path}` }] };
      }
      try {
        if (timestamps) {
          const out = await transcribeWithTimestamps(path);
          return {
            content: [{ type: "text" as const, text: out.text }],
            structuredContent: { text: out.text, segments: out.segments ?? [] },
          };
        }
        const text = await transcribe(path);
        return {
          content: [{ type: "text" as const, text: text }],
          structuredContent: { text, segments: [] },
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: toToolError(err) }] };
      }
    },
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
      try {
        const voices = await listVoices();
        return {
          content: [{ type: "text" as const, text: `${voices.length} voices installed.` }],
          structuredContent: { voices },
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `list_voices failed: ${toToolError(err)}` }] };
      }
    },
  );
}

function toToolError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
