import * as ort from "onnxruntime-node";
import { join } from "path";
import { ensureOrtBackend } from "./ort-backend-fix";

let session: ort.InferenceSession | null = null;

export async function initEncoder(modelDir: string): Promise<void> {
  if (session) return;
  ensureOrtBackend();
  session = await ort.InferenceSession.create(join(modelDir, "encoder-model.onnx"));
}

export async function encode(
  features: ort.Tensor,
  length: ort.Tensor
): Promise<{ encoderOutput: ort.Tensor; encodedLength: number }> {
  if (!session) throw new Error("encoder not initialized");

  const results = await session.run({
    audio_signal: features,
    length: length,
  });

  const encoderOutput = results["outputs"];
  const encodedLength = Number((results["encoded_lengths"].data as BigInt64Array)[0]);

  return { encoderOutput, encodedLength };
}

export function releaseEncoder(): void {
  session = null;
}
