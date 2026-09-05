import {
  assertSpeakerModelsInstalled,
  buildTranscribeArgs,
  getDescribe,
  isEngineInstalled,
  transcribeEngine,
  transcribeEngineWithSegments,
  type TranscriptionOutput,
  type VadMode,
} from "./engine";
import { validateArgv } from "./engine/describe";
import { installHint } from "./install-hint";

export type { VadMode };
export type { TranscriptionOutput };

export interface TranscribeOptions {
  /** Silero VAD preprocessing selector. Defaults to `"auto"`. */
  vad?: VadMode;
  /** Cancel any in-flight engine subprocess for this transcription. */
  signal?: AbortSignal;
  /** Request timestamped transcript segments from the engine. */
  timestamps?: boolean;
  /** Request speaker labels in transcript segments (#199). Implies `timestamps`.
   * Currently darwin-arm64 only — throws when the engine doesn't advertise
   * `transcribe.diarize`. */
  speakers?: boolean;
  /** Rewrite spoken-form numbers, money, dates and times in the transcript to
   * written form (#710). English-only in practice; other languages pass
   * through unchanged. Throws when the engine doesn't advertise
   * `transcribe.itn`. */
  itn?: boolean;
  /** Receives the engine's progress lines as it writes them, rather than once the run
   * is over. The diarization model load alone can take ~100 s on a first run, and a
   * caller with no way to show that in flight looks like it has hung (#1002). */
  onProgressLine?: (line: string) => void;
}

export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<string> {
  return (await transcribeWithSegments(audioPath, opts)).text;
}

/** Refuses a request the installed engine cannot serve, before any progress UI or spawn. */
export async function validateTranscribeRequest(opts: TranscribeOptions = {}): Promise<void> {
  if (!isEngineInstalled()) {
    throw new Error(
      "Error: No transcription backend is installed.\n\n" +
        "Run the following to get started:\n\n" +
        "    bun add -g @drakulavich/kesha-voice-kit\n" +
        `    ${installHint()}`,
    );
  }
  const json = Boolean(opts.timestamps || opts.speakers);
  const engineOpts = { vad: opts.vad, speakers: opts.speakers, itn: opts.itn };
  validateArgv(buildTranscribeArgs("<input>", engineOpts, json), await getDescribe());
  if (opts.speakers) assertSpeakerModelsInstalled();
}

export async function transcribeWithSegments(
  audioPath: string,
  opts: TranscribeOptions = {},
): Promise<TranscriptionOutput> {
  await validateTranscribeRequest(opts);

  if (opts.timestamps || opts.speakers) {
    return transcribeEngineWithSegments(audioPath, {
      vad: opts.vad,
      signal: opts.signal,
      speakers: opts.speakers,
      itn: opts.itn,
      onProgressLine: opts.onProgressLine,
    });
  }

  const text = await transcribeEngine(audioPath, {
    vad: opts.vad,
    signal: opts.signal,
    itn: opts.itn,
    onProgressLine: opts.onProgressLine,
  });
  return { text, segments: [] };
}
