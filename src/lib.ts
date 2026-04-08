import { existsSync } from "fs";
import { transcribe as internalTranscribe, type TranscribeOptions } from "./transcribe";
import { downloadModel } from "./onnx-install";
import { downloadCoreML } from "./coreml-install";

export type { TranscribeOptions };
export { downloadModel, downloadCoreML };

export async function transcribe(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<string> {
  if (!existsSync(audioPath)) {
    throw new Error(`File not found: ${audioPath}`);
  }

  return internalTranscribe(audioPath, options);
}
