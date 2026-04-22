import { isEngineInstalled, transcribeEngine } from "./engine";

export interface TranscribeOptions {
  silent?: boolean;
  /** Run Silero VAD preprocessing: segment the audio first, then transcribe
   *  each speech span and stitch results (#128). Opt-in — requires the VAD
   *  model to be installed (`kesha install --vad`). */
  vad?: boolean;
}

export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<string> {
  if (!isEngineInstalled()) {
    throw new Error(
      "Error: No transcription backend is installed\n\n" +
      "╔══════════════════════════════════════════════════════════╗\n" +
      "║ Please run the following command to get started:         ║\n" +
      "║                                                          ║\n" +
      "║     bunx @drakulavich/kesha-voice-kit install               ║\n" +
      "╚══════════════════════════════════════════════════════════╝",
    );
  }

  return transcribeEngine(audioPath, { vad: opts.vad });
}
