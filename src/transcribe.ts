import { requireModel, isModelCached, installHintError } from "./onnx-install";
import { isCoreMLInstalled, transcribeCoreML, isMacArm64 } from "./coreml";
import { log } from "./log";
import { convertToFloat32PCM } from "./audio";
import { initPreprocessor, preprocess } from "./preprocess";
import { initEncoder, encode } from "./encoder";
import {
  initDecoder,
  createOnnxDecoderSession,
  beamDecode,
} from "./decoder";
import { Tokenizer } from "./tokenizer";
import { join } from "path";

function transpose2D(data: Float32Array, rows: number, cols: number): Float32Array {
  const out = new Float32Array(cols * rows);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      out[c * rows + r] = data[r * cols + c];
    }
  }
  return out;
}

// Parakeet TDT 0.6B decoder state dimensions (from ONNX model input shapes)
const DECODER_LAYERS = 2;
const DECODER_HIDDEN = 640;

export interface TranscribeOptions {
  beamWidth?: number;
  modelDir?: string;
  silent?: boolean;
}

// Minimum 0.1s of audio at 16kHz to produce meaningful output
const MIN_AUDIO_SAMPLES = 1600;

export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<string> {
  if (isCoreMLInstalled()) {
    return transcribeCoreML(audioPath);
  }

  if (!opts.silent && isMacArm64()) {
    log.warn("CoreML backend unavailable, falling back to ONNX");
  }

  if (isModelCached(opts.modelDir)) {
    return transcribeOnnx(audioPath, opts);
  }

  throw installHintError("Error: No transcription backend is installed");
}

async function transcribeOnnx(audioPath: string, opts: TranscribeOptions): Promise<string> {
  const audio = await convertToFloat32PCM(audioPath);

  if (audio.length < MIN_AUDIO_SAMPLES) {
    if (!opts.silent) {
      log.warn(`Audio too short (< 0.1s), skipping: ${audioPath}`);
    }
    return "";
  }

  const beamWidth = opts.beamWidth ?? 4;
  const modelDir = requireModel(opts.modelDir);

  const [tokenizer] = await Promise.all([
    Tokenizer.fromFile(join(modelDir, "vocab.txt")),
    initPreprocessor(modelDir),
    initEncoder(modelDir),
    initDecoder(modelDir),
  ]);

  const { features, length } = await preprocess(audio);
  const { encoderOutput, encodedLength } = await encode(features, length);

  const encoderData = encoderOutput.data as Float32Array;
  const dims = encoderOutput.dims as readonly number[];
  const D = dims[1];
  const T = dims[2];

  const transposed = transpose2D(encoderData, D, T);

  const session = createOnnxDecoderSession(
    tokenizer.vocabSize,
    tokenizer.blankId,
    DECODER_LAYERS,
    DECODER_HIDDEN,
  );

  const tokens = await beamDecode(session, encodedLength, transposed, D, beamWidth);
  return tokenizer.detokenize(tokens);
}
