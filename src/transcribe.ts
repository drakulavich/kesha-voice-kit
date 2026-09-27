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
import { KeshaError } from "./engine/events";
import { installHint } from "./install-hint";
import { existsSync, statSync } from "fs";

export type { VadMode };

/** True when `path` exists and is a directory; the CLI and the Core API both refuse one before any engine spawn. */
export function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

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

/** The refusals the CLI makes before it spawns anything, so an agent branching on the documented code sees it on every surface. */
export function assertAudioFileArgument(audioPath: string): void {
  if (!existsSync(audioPath)) {
    throw new KeshaError("E_INPUT_NOT_FOUND", `File not found: ${audioPath}`);
  }
  if (isDirectoryPath(audioPath)) {
    throw new KeshaError("E_INVALID_ARG", `${audioPath}: is a directory (expected an audio file)`);
  }
}

/** The CLI's gate before any progress UI: the engine, its describe document, the request's flags, and the model files a request needs; the argv actually sent is validated again at the spawn. */
export async function validateTranscribeRequest(opts: TranscribeOptions = {}): Promise<void> {
  if (!isEngineInstalled()) {
    throw new KeshaError("E_ENGINE_SPAWN", "No transcription backend is installed", {
      hint: `bun add -g @drakulavich/kesha-voice-kit, then ${installHint()}`,
    });
  }
  validateArgv(
    buildTranscribeArgs(
      "<input>",
      { vad: opts.vad, speakers: opts.speakers, itn: opts.itn },
      Boolean(opts.timestamps || opts.speakers),
    ),
    await getDescribe(),
  );
  if (opts.speakers) assertSpeakerModelsInstalled();
}

export async function transcribeWithSegments(
  audioPath: string,
  opts: TranscribeOptions = {},
): Promise<TranscriptionOutput> {
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
