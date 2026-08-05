#!/usr/bin/env bun
/**
 * Gate between populating FluidAudio's ASR bundle and saving it to the shared cache.
 *
 * `kesha-engine install` treats a warm-up failure as non-fatal, so a cold seed run whose
 * download died partway still exits 0. Saving that writes a partial bundle under an
 * immutable exact key: later seed probes hit it and skip repair, while every PR restores
 * the broken entry (#675).
 */
import { existsSync } from "fs";
import { join } from "path";
import { FLUID_ASR_REQUIRED, fluidAsrCachePath } from "../../src/fluid-asr-cache";

const dir = fluidAsrCachePath();
const missing = FLUID_ASR_REQUIRED.filter((entry) => !existsSync(join(dir, entry)));

if (missing.length > 0) {
  console.error(`Refusing to seed an incomplete FluidAudio ASR bundle at ${dir}`);
  console.error(`missing: ${missing.join(", ")}`);
  console.error("The populate step reported success, so this is a partial or failed fetch.");
  process.exit(1);
}

console.log(`FluidAudio ASR bundle complete at ${dir} (${FLUID_ASR_REQUIRED.length} entries).`);
