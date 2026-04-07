import { requireModel } from "./models";
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
}

// Minimum 0.1s of audio at 16kHz to produce meaningful output
const MIN_AUDIO_SAMPLES = 1600;

export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<string> {
  const audio = await convertToFloat32PCM(audioPath);

  if (audio.length < MIN_AUDIO_SAMPLES) {
    return "";
  }

  const beamWidth = opts.beamWidth ?? 4;
  const modelDir = requireModel(opts.modelDir);
  const tokenizer = await Tokenizer.fromFile(join(modelDir, "vocab.txt"));

  await initPreprocessor(modelDir);
  await initEncoder(modelDir);
  await initDecoder(modelDir);

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
