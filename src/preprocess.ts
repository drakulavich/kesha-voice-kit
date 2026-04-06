import * as ort from "onnxruntime-node";
import { join } from "path";
import { ensureOrtBackend } from "./ort-backend-fix";

let session: ort.InferenceSession | null = null;

export async function initPreprocessor(modelDir: string): Promise<void> {
  if (session) return;
  ensureOrtBackend();
  session = await ort.InferenceSession.create(join(modelDir, "nemo128.onnx"));
}

export async function preprocess(audio: Float32Array): Promise<{ features: ort.Tensor; length: ort.Tensor }> {
  if (!session) throw new Error("preprocessor not initialized");

  const inputTensor = new ort.Tensor("float32", audio, [1, audio.length]);
  const lengthTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(audio.length)]), [1]);

  const results = await session.run({
    waveforms: inputTensor,
    waveforms_lens: lengthTensor,
  });

  const melData = results["features"].data as Float32Array;
  const melDims = results["features"].dims as readonly number[];
  const T = melDims[2];
  const actualLength = Number((results["features_lens"].data as BigInt64Array)[0]);

  const numFeatures = melDims[1];
  const normalized = new Float32Array(melData.length);

  for (let f = 0; f < numFeatures; f++) {
    let sum = 0;
    let sumSq = 0;

    for (let t = 0; t < actualLength; t++) {
      const val = melData[f * T + t];
      sum += val;
      sumSq += val * val;
    }

    const mean = sum / actualLength;
    const variance = sumSq / actualLength - mean * mean;
    const std = Math.sqrt(Math.max(variance, 1e-10));

    for (let t = 0; t < T; t++) {
      normalized[f * T + t] = t < actualLength ? (melData[f * T + t] - mean) / std : 0;
    }
  }

  const featureTensor = new ort.Tensor("float32", normalized, melDims as number[]);
  const outputLength = new ort.Tensor("int64", BigInt64Array.from([BigInt(actualLength)]), [1]);

  return { features: featureTensor, length: outputLength };
}

export function releasePreprocessor(): void {
  session = null;
}
