import { existsSync } from "fs";
import { transcribe as internalTranscribe, type TranscribeOptions } from "./transcribe";
import { downloadModel } from "./models";

export type { TranscribeOptions };
export { downloadModel };

export async function transcribe(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<string> {
  if (!existsSync(audioPath)) {
    throw new Error(`File not found: ${audioPath}`);
  }

  return internalTranscribe(audioPath, options);
}
