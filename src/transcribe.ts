import { ensureModel } from "./models";
import { convertToFloat32PCM } from "./audio";
import { initPreprocessor, preprocess } from "./preprocess";
import { initEncoder, encode } from "./encoder";
import {
  initDecoder,
  createOnnxDecoderSession,
  greedyDecode,
} from "./decoder";
import { Tokenizer } from "./tokenizer";
import { join } from "path";

// Parakeet TDT 0.6B decoder state dimensions (from ONNX model input shapes)
const DECODER_LAYERS = 2;
const DECODER_HIDDEN = 640;

export interface TranscribeOptions {
  noCache?: boolean;
}

export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<string> {
  const audio = await convertToFloat32PCM(audioPath);

  if (audio.length < 1600) {
    return "";
  }

  const noCache = opts.noCache ?? false;
  const modelDir = await ensureModel("v3", noCache);
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

  // Transpose from [1, D, T] to [T, D] so each frame is contiguous
  const transposed = new Float32Array(T * D);
  for (let t = 0; t < T; t++) {
    for (let d = 0; d < D; d++) {
      transposed[t * D + d] = encoderData[d * T + t];
    }
  }

  const session = createOnnxDecoderSession(
    tokenizer.vocabSize,
    tokenizer.blankId,
    DECODER_LAYERS,
    DECODER_HIDDEN,
  );

  const tokens = await greedyDecode(session, encodedLength, transposed, D);
  return tokenizer.detokenize(tokens);
}
