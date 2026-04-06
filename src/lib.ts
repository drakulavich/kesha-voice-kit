import { existsSync } from "fs";
import { transcribe as internalTranscribe } from "./transcribe";

export interface TranscribeOptions {
  beamWidth?: number;
  noCache?: boolean;
  modelDir?: string;
}

export async function transcribe(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<string> {
  if (!existsSync(audioPath)) {
    throw new Error(`File not found: ${audioPath}`);
  }

  return internalTranscribe(audioPath, {
    noCache: options.noCache ?? false,
    beamWidth: options.beamWidth,
    modelDir: options.modelDir,
  });
}
