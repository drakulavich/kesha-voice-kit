import { isEngineInstalled, transcribeEngine, type VadMode } from "./engine";

export type { VadMode };

export interface TranscribeOptions {
  silent?: boolean;
  /** Silero VAD preprocessing selector. Defaults to `"auto"`. */
  vad?: VadMode;
}

export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<string> {
  if (!isEngineInstalled()) {
    throw new Error(
      "Error: No transcription backend is installed\n\n" +
      "╔══════════════════════════════════════════════════════════╗\n" +
      "║ Please run the following command to get started:         ║\n" +
      "║                                                          ║\n" +
      "║     bunx @drakulavich/kesha-voice-kit install               ║\n" +
      "╚══════════════════════════════════════════════════════════╝",
    );
  }

  return transcribeEngine(audioPath, { vad: opts.vad });
}
