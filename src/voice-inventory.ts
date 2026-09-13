import { readdirSync, statSync } from "fs";
import { join } from "path";
import modelPlan from "../model-plan.json" with { type: "json" };
import { isEngineInstalled } from "./engine";
import { log } from "./log";
import { keshaCacheDir } from "./paths";
import { listVoiceIds } from "./synth";

/** The `say --list-voices` deadline, shared with the describe probe so a wedged engine cannot hang a diagnostic. */
const LIST_VOICES_TIMEOUT_MS = 15_000;

/**
 * Voice ids the engine's own `say --list-voices` union reports, which is the set `say` will
 * accept — the cache scan below sees neither the FluidAudio ANE packs nor AVSpeech (T2-6).
 *
 * Falls back to the scan whenever no engine can answer, so a diagnostic still says something
 * useful on a machine with no engine or a build without tts.
 */
export async function installedVoiceIds(): Promise<string[]> {
  if (!isEngineInstalled()) return cachedVoiceIds();
  try {
    return await listVoiceIds({}, AbortSignal.timeout(LIST_VOICES_TIMEOUT_MS));
  } catch (err) {
    log.debug(`say --list-voices failed, falling back to the cache scan: ${String(err)}`);
    return cachedVoiceIds();
  }
}

/** Voice ids derivable from the Kesha model cache alone; an engine-free lower bound on [`installedVoiceIds`]. */
export function cachedVoiceIds(): string[] {
  const cache = keshaCacheDir();
  const voices: string[] = [];
  try {
    const kokoro = readdirSync(join(cache, "models", "kokoro-82m", "voices"));
    for (const f of kokoro) {
      if (f.endsWith(".bin")) voices.push(`en-${f.replace(/\.bin$/, "")}`);
    }
  } catch {
    /* Kokoro not installed */
  }
  try {
    // Joined to `models/manifest.rs::VOSK_RU_FILES` through the plan, so a sixth entry needs no edit here (#1132).
    for (const { relPath } of modelPlan.voskRu) statSync(join(cache, relPath));
    for (const id of ["f01", "f02", "f03", "m01", "m02"]) {
      voices.push(`ru-vosk-${id}`);
    }
  } catch {
    /* Vosk not installed */
  }
  return voices.sort();
}
