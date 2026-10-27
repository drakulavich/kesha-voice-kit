import {
  assertSpeakerModelsInstalled,
  buildTranscribeArgs,
  engineMissingError,
  getDescribe,
  isEngineInstalled,
  transcribeEngine,
  transcribeEngineWithSegments,
  type TranscriptionOutput,
  type VadMode,
} from "./engine";
import { validateArgv } from "./engine/describe";
import { KeshaError } from "./engine/events";
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type { VadMode };

/** True when `path` exists and is a directory; the CLI and the Core API both refuse one before any engine spawn. */
export function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The next step for E_INPUT_NOT_FOUND, shared by the CLI and the Core API. */
export function missingFileHint(path: string): string {
  return isAbsolute(path) ? "check the path" : `check the path, relative to the current directory ${process.cwd()}`;
}

export const SPECIAL_FILE_HINT =
  "kesha reads its input more than once, so a named pipe, /dev/stdin or <(...) cannot work; save the audio to a file and pass that.";

/** True when `path` exists and is neither a regular file nor a directory: the engine opens its input more than once, so a FIFO, `/dev/stdin` or `<(...)` hangs it (#1468). */
export function isSpecialFilePath(path: string): boolean {
  // stat follows /dev/stdin to whatever stdin holds, so `kesha /dev/stdin < en.wav` would look like a regular file.
  if (path === "/dev/stdin" || path.startsWith("/dev/fd/")) return true;
  try {
    const st = statSync(path);
    return !st.isFile() && !st.isDirectory();
  } catch {
    return false;
  }
}

/** Seconds a RIFF WAV's data chunk declares and seconds the file holds, when the file is shorter than its header says; null otherwise. */
function truncatedWavSeconds(path: string): { declared: number; present: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(20);
    if (
      readSync(fd, buf, 0, 12, 0) < 12 ||
      buf.toString("ascii", 0, 4) !== "RIFF" ||
      buf.toString("ascii", 8, 12) !== "WAVE"
    ) {
      return null;
    }
    let byteRate = 0;
    for (let offset = 12; offset + 8 <= size;) {
      readSync(fd, buf, 0, 20, offset);
      const id = buf.toString("ascii", 0, 4);
      const length = buf.readUInt32LE(4);
      if (id === "fmt ") byteRate = buf.readUInt32LE(16);
      if (id === "data") {
        const present = size - offset - 8;
        // Streaming writers leave 0xFFFFFFFF in the size field when they cannot seek back to fill it in.
        if (length === 0xffffffff || byteRate === 0 || length <= present) return null;
        return { declared: length / byteRate, present: present / byteRate };
      }
      offset += 8 + length + (length % 2);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The warning the CLI, the Core API and MCP give for a WAV shorter than its header says; null for any other file. */
export function truncatedWavWarning(path: string): string | null {
  const truncated = truncatedWavSeconds(path);
  if (!truncated) return null;
  return `warning: ${path} is truncated: its header declares ${truncated.declared.toFixed(1)} s of audio but the file holds ${truncated.present.toFixed(1)} s; transcribing the part present`;
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
    throw new KeshaError("E_INPUT_NOT_FOUND", `File not found: ${audioPath}`, { hint: missingFileHint(audioPath) });
  }
  if (isDirectoryPath(audioPath)) {
    throw new KeshaError("E_INVALID_ARG", `${audioPath}: is a directory (expected an audio file)`);
  }
  if (isSpecialFilePath(audioPath)) {
    throw new KeshaError("E_INVALID_ARG", `${audioPath}: is not a regular file (expected an audio file)`, {
      hint: SPECIAL_FILE_HINT,
    });
  }
}

/** The CLI's gate before any progress UI: the engine, its describe document, the request's flags, and the model files a request needs; the argv actually sent is validated again at the spawn. */
export async function validateTranscribeRequest(opts: TranscribeOptions = {}): Promise<void> {
  if (!isEngineInstalled()) {
    throw engineMissingError("transcription");
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
