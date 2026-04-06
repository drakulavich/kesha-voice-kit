import * as ort from "onnxruntime-node";
import { join } from "path";
import { ensureOrtBackend } from "./ort-backend-fix";

// TDT allows multiple tokens per encoder frame; cap to prevent runaway decoding
const MAX_TOKENS_PER_STEP = 10;

type F32 = Float32Array<ArrayBufferLike>;

export interface DecoderSession {
  decode(
    encoderFrame: F32,
    targets: number[],
    targetLength: number,
    state1: F32,
    state2: F32
  ): Promise<{ output: F32; state1: F32; state2: F32 }>;
  vocabSize: number;
  blankId: number;
  stateDims: { layers: number; hidden: number };
}

export async function greedyDecode(
  session: DecoderSession,
  encoderLength: number,
  encoderData?: Float32Array,
  encoderDim?: number
): Promise<number[]> {
  if (encoderLength === 0) return [];

  const tokens: number[] = [];
  const stateSize = session.stateDims.layers * session.stateDims.hidden;
  let state1: F32 = new Float32Array(stateSize);
  let state2: F32 = new Float32Array(stateSize);
  let lastToken = session.blankId;

  let t = 0;
  while (t < encoderLength) {
    let tokensThisStep = 0;

    while (tokensThisStep < MAX_TOKENS_PER_STEP) {
      let frame: Float32Array;
      if (encoderData && encoderDim) {
        // Must copy — ort.Tensor doesn't work with subarray views under Bun
        frame = encoderData.slice(t * encoderDim, (t + 1) * encoderDim);
      } else {
        frame = new Float32Array(1);
      }

      const result = await session.decode(frame, [lastToken], 1, state1, state2);
      const output = result.output;

      const tokenLogits = output.slice(0, session.vocabSize);
      const durationLogits = output.slice(session.vocabSize);

      const tokenId = argmax(tokenLogits);
      const duration = argmax(durationLogits);

      state1 = result.state1;
      state2 = result.state2;

      if (tokenId === session.blankId) {
        t += 1;
        break;
      }

      tokens.push(tokenId);
      lastToken = tokenId;
      tokensThisStep++;

      if (duration > 0) {
        t += duration;
        break;
      }
    }

    if (tokensThisStep >= MAX_TOKENS_PER_STEP) {
      t += 1;
    }
  }

  return tokens;
}

function argmax(arr: Float32Array): number {
  let maxIdx = 0;
  let maxVal = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > maxVal) {
      maxVal = arr[i];
      maxIdx = i;
    }
  }
  return maxIdx;
}

let onnxSession: ort.InferenceSession | null = null;

export async function initDecoder(modelDir: string): Promise<void> {
  if (onnxSession) return;
  ensureOrtBackend();
  onnxSession = await ort.InferenceSession.create(join(modelDir, "decoder_joint-model.onnx"));
}

export function createOnnxDecoderSession(
  vocabSize: number,
  blankId: number,
  layers: number,
  hidden: number
): DecoderSession {
  return {
    vocabSize,
    blankId,
    stateDims: { layers, hidden },
    async decode(encoderFrame, targets, targetLength, state1, state2) {
      if (!onnxSession) throw new Error("decoder not initialized");

      const D = encoderFrame.length;
      const results = await onnxSession.run({
        encoder_outputs: new ort.Tensor("float32", encoderFrame, [1, D, 1]),
        targets: new ort.Tensor("int32", Int32Array.from(targets), [1, targets.length]),
        target_length: new ort.Tensor("int32", Int32Array.from([targetLength]), [1]),
        input_states_1: new ort.Tensor("float32", state1, [layers, 1, hidden]),
        input_states_2: new ort.Tensor("float32", state2, [layers, 1, hidden]),
      });

      return {
        output: new Float32Array(results["outputs"].data as Float32Array),
        state1: new Float32Array(results["output_states_1"].data as Float32Array),
        state2: new Float32Array(results["output_states_2"].data as Float32Array),
      };
    },
  };
}
