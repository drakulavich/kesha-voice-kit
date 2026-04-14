import { isEngineInstalled, transcribeEngine } from "./engine";

export interface TranscribeOptions {
  silent?: boolean;
}

export async function transcribe(audioPath: string, _opts: TranscribeOptions = {}): Promise<string> {
  if (!isEngineInstalled()) {
    throw new Error(
      "Error: No transcription backend is installed\n\n" +
      "╔══════════════════════════════════════════════════════════╗\n" +
      "║ Please run the following command to get started:         ║\n" +
      "║                                                          ║\n" +
      "║     bunx @drakulavich/parakeet-cli install               ║\n" +
      "╚══════════════════════════════════════════════════════════╝",
    );
  }

  return transcribeEngine(audioPath);
}
