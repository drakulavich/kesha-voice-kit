import { getDescribe } from "./engine";
import type { DescribeDocument } from "./engine/describe";
import { KeshaError } from "./engine/events";
import { assertPlatformCanInstall, installEngine } from "./engine-install";
import { errorMessage } from "./error-utils";
import {
  installableTtsLangs,
  probeCapabilitiesForInstall,
  resolveEngineVersionFlag,
  resolveTtsLangs,
  unavailableBackendRefusal,
} from "./cli/install";
import { detectTextLanguageFallback, routeLanguage } from "./language-routing";
import { say as synthesize, type SayOptions } from "./synth";
import { assertAudioFileArgument, transcribeWithSegments, type TranscribeOptions } from "./transcribe";
import type { TranscribeResult } from "./types";

export { KeshaError };
export type { SayOptions, TranscribeOptions };
export type { TranscriptionSegment, VadMode, WordTiming } from "./engine";
export type { TranscribeErrorRecord, TranscribeJsonOutput, TranscribeResult } from "./types";
export { hasErrorRecords } from "./types";

/** Encodes a `TranscribeResult[]` exactly as `kesha --toon` prints it; pass `errors` for the `--include-errors` envelope. */
export { formatToonOutput as toToon } from "./toon";

/** The installed Engine's `describe` document: its backend, profile, features, per-command flags and TTS languages. */
export type EngineDescription = DescribeDocument;

/** One field per `kesha install` flag; `install()` with none installs the Engine and the ASR models. */
export interface InstallOptions {
  /** `--tts <langs…>`: the TTS languages to install. Empty or absent installs none. */
  tts?: string[];
  /** `--vad`: the Silero VAD model for long-audio preprocessing. */
  vad?: boolean;
  /** `--diarize`: the speaker-diarization model; darwin-arm64 only. */
  diarize?: boolean;
  /** `--no-cache`: re-download even what is cached. */
  noCache?: boolean;
  /** `--coreml` / `--onnx`: refused unless it is the backend this platform ships. */
  backend?: "coreml" | "onnx";
  /** `--engine-version`: an exact Engine release instead of the pinned one, for this call only. */
  engineVersion?: string;
}

/** Every Core API rejection is a `KeshaError`; one nothing coded becomes `E_INTERNAL`, the catch-all the Engine publishes for both origins. */
async function coded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof KeshaError) throw err;
    throw new KeshaError("E_INTERNAL", errorMessage(err));
  }
}

/** Transcribes one audio file. `segments` is present only when `timestamps` or `speakers` is set; `lang` comes from the transcript text. */
export function transcribe(audioPath: string, options: TranscribeOptions = {}): Promise<TranscribeResult> {
  return coded(async () => {
    assertAudioFileArgument(audioPath);
    const startedAt = performance.now();
    const { text, segments } = await transcribeWithSegments(audioPath, options);
    const textLanguage = detectTextLanguageFallback(text);
    const result: TranscribeResult = {
      file: audioPath,
      text,
      lang: routeLanguage({ textLanguage }).lang,
      sttTimeMs: Math.round(performance.now() - startedAt),
    };
    if (textLanguage) result.textLanguage = textLanguage;
    if (options.timestamps || options.speakers) result.segments = segments;
    return result;
  });
}

/** Synthesizes speech; resolves to the audio bytes, or to an empty array when `out` names a file. */
export function say(options: SayOptions): Promise<Uint8Array> {
  return coded(() => synthesize(options));
}

/** Resolves to a copy of the installed Engine's describe document; never downloads anything. */
export function capabilities(): Promise<EngineDescription> {
  return coded(async () => structuredClone(await getDescribe()));
}

/** The one Core API call that downloads: what `kesha install` does for the same flags, with the same refusals first. */
export function install(options: InstallOptions = {}): Promise<void> {
  return coded(async () => {
    const version = resolveEngineVersionFlag(options.engineVersion);
    const ttsLangs = options.tts ?? [];
    if (ttsLangs.length > 0) {
      const caps = await probeCapabilitiesForInstall();
      const supported = caps?.tts?.languages.map((l) => l.code) ?? installableTtsLangs();
      try {
        resolveTtsLangs({ tts: true, positionals: ttsLangs }, supported);
      } catch (err) {
        throw new KeshaError("E_INVALID_ARG", errorMessage(err));
      }
    }
    assertPlatformCanInstall({ diarize: options.diarize });
    const refusal = unavailableBackendRefusal(options.backend);
    if (refusal) throw refusal;
    await installEngine({
      noCache: options.noCache ?? false,
      backend: options.backend,
      ttsLangs,
      vad: options.vad ?? false,
      diarize: options.diarize ?? false,
      version,
    });
  });
}
