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

const DEFAULT_BEAM_WIDTH = 4;

interface Beam {
  tokens: number[];
  score: number;
  lastToken: number;
  state1: F32;
  state2: F32;
  t: number;
}

export async function beamDecode(
  session: DecoderSession,
  encoderLength: number,
  encoderData: Float32Array,
  encoderDim: number,
  beamWidth: number = DEFAULT_BEAM_WIDTH,
): Promise<number[]> {
  if (encoderLength === 0) return [];

  const stateSize = session.stateDims.layers * session.stateDims.hidden;

  let beams: Beam[] = [{
    tokens: [],
    score: 0,
    lastToken: session.blankId,
    state1: new Float32Array(stateSize),
    state2: new Float32Array(stateSize),
    t: 0,
  }];

  const maxSteps = encoderLength * MAX_TOKENS_PER_STEP;

  for (let step = 0; step < maxSteps; step++) {
    const active = beams.filter(b => b.t < encoderLength);
    if (active.length === 0) break;

    const candidates: Beam[] = [];

    for (const beam of active) {
      // Must copy — ort.Tensor doesn't work with subarray views under Bun
      const frame = encoderData.slice(beam.t * encoderDim, (beam.t + 1) * encoderDim);
      const result = await session.decode(frame, [beam.lastToken], 1, beam.state1, beam.state2);
      const output = result.output;

      const tokenLogits = output.slice(0, session.vocabSize);
      const durationLogits = output.slice(session.vocabSize);
      const duration = argmax(durationLogits);

      // Blank option: advance one frame, keep same tokens
      candidates.push({
        tokens: beam.tokens,
        score: beam.score + tokenLogits[session.blankId],
        lastToken: beam.lastToken,
        state1: result.state1,
        state2: result.state2,
        t: beam.t + 1,
      });

      // Top non-blank token options
      const topK = topKIndices(tokenLogits, beamWidth, session.blankId);
      for (const tokenId of topK) {
        candidates.push({
          tokens: [...beam.tokens, tokenId],
          score: beam.score + tokenLogits[tokenId],
          lastToken: tokenId,
          state1: result.state1,
          state2: result.state2,
          t: duration > 0 ? beam.t + duration : beam.t,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    beams = candidates.slice(0, beamWidth);
  }

  return beams[0].tokens;
}

function argmax(arr: F32): number {
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

function topKIndices(arr: F32, k: number, excludeId: number): number[] {
  const indexed: [number, number][] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i !== excludeId) indexed.push([arr[i], i]);
  }
  indexed.sort((a, b) => b[0] - a[0]);
  return indexed.slice(0, k).map(([, i]) => i);
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
