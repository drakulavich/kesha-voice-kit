import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorMessage } from "../error-utils";
import { z } from "zod";
import { chmodSync, existsSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import { transcribe, transcribeWithTimestamps } from "../lib";
import { listVoices, aggregateLanguages } from "./voices";
import { say, type SayFormat } from "../synth";
import { allocAudioPath, audioDir } from "./audio-output";

export function registerTools(server: McpServer): void {
  function mimeForExt(file: string): string {
    if (file.endsWith(".flac")) return "audio/flac";
    if (file.endsWith(".ogg")) return "audio/ogg";
    return "audio/wav";
  }

  server.registerResource(
    "synthesized-audio",
    new ResourceTemplate("kesha-audio://{file}", { list: undefined }),
    { title: "Synthesized audio", description: "WAV/OGG/FLAC produced by synthesize_speech." },
    async (uri, { file }) => {
      const name = basename(String(file)); // sandbox: reject path traversal
      const filePath = join(audioDir(), name);
      let bytes: Buffer;
      try {
        bytes = readFileSync(filePath);
      } catch {
        throw new Error(`synthesized-audio: file not found or already swept: ${name}`);
      }
      return { contents: [{ uri: uri.href, mimeType: mimeForExt(name), blob: bytes.toString("base64") }] };
    },
  );

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
        rate: z.number().optional().describe("Speaking rate 0.5-2.0"),
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
        return { isError: true, content: [{ type: "text" as const, text: "request cancelled" }] };
      }
      if (rate !== undefined && !(rate >= 0.5 && rate <= 2.0)) {
        return { isError: true, content: [{ type: "text" as const, text: `rate ${rate} out of range (0.5-2.0)` }] };
      }
      const fmt: SayFormat = format ?? "wav";
      const outPath = allocAudioPath(fmt);
      try {
        await say({ text, voice, rate, format: fmt, out: outPath });
        chmodSync(outPath, 0o600);
        const bytes = statSync(outPath).size;
        const file = basename(outPath);
        const uri = `kesha-audio://${file}`;
        const mimeType = mimeForExt(file);
        const resolvedVoice = voice ?? "(auto)";
        return {
          content: [
            { type: "resource_link" as const, uri, name: file, mimeType },
            { type: "text" as const, text: `Synthesized ${bytes} bytes (voice=${resolvedVoice}, format=${fmt}); read via resources/read ${uri}.` },
          ],
          structuredContent: { uri, path: outPath, format: fmt, voice: resolvedVoice, bytes },
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: errorMessage(err) }] };
      }
    },
  );

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
        return { isError: true, content: [{ type: "text" as const, text: errorMessage(err) }] };
      }
    },
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
            voiceId: z.string(),
            modelId: z.enum(["kokoro", "vosk", "avspeech", "unknown"]),
            modelName: z.string(),
            languageCode: z.string(),
            languageName: z.string(),
            gender: z.enum(["male", "female"]).nullable(),
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
        return { isError: true, content: [{ type: "text" as const, text: `list_voices failed: ${errorMessage(err)}` }] };
      }
    },
  );

  server.registerTool(
    "list_languages",
    {
      title: "List languages",
      description: "List languages available for synthesis, derived from installed voices.",
      inputSchema: {},
      outputSchema: {
        languages: z.array(
          z.object({
            languageCode: z.string(),
            languageName: z.string(),
            voiceCount: z.number(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const languages = aggregateLanguages(await listVoices());
        return {
          content: [{ type: "text" as const, text: `${languages.length} languages available.` }],
          structuredContent: { languages },
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `list_languages failed: ${errorMessage(err)}` }] };
      }
    },
  );
}
