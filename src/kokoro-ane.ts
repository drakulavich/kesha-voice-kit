import { existsSync } from "fs";
import { join } from "path";
import { diagnosticHomeDir, dirSizeBytes } from "./diagnostic-paths";
import { isDarwinArm64 } from "./engine-targets";
import { kokoroAneDir, kokoroG2pDir } from "./fluid-roots";

/**
 * What darwin-arm64 Kokoro actually needs on disk, and who puts it there. Since #856 these
 * are Kesha's own hash-verified downloads rather than a cache FluidAudio fills mid-synthesis,
 * and `kesha say` refuses to run without them instead of fetching them behind the user (#823).
 */
export const KOKORO_ANE_NOTE =
  "staged and hash-verified by `kesha install --tts`, outside Kesha's pinned model cache " +
  "because FluidAudio resolves these paths and no other; the warm-up only compiles them";

/**
 * Top level of `models/manifest.rs::ANE_EN_FILES`: the 7-stage ANE chain, its vocab, and the
 * `af_heart` pack the bundle counts as its own.
 */
export const KOKORO_ANE_EN_REQUIRED = [
  "KokoroAlbert.mlmodelc",
  "KokoroAlignment.mlmodelc",
  "KokoroNoise_v2.mlmodelc",
  "KokoroPostAlbert.mlmodelc",
  "KokoroProsody.mlmodelc",
  "KokoroTail.mlmodelc",
  "KokoroVocoder.mlmodelc",
  "af_heart.bin",
  "vocab.json",
];

/** Top level of `models/manifest.rs::KOKORO_G2P_FILES` — the shared BART G2P and the Misaki lexicon. */
export const KOKORO_G2P_REQUIRED = [
  "G2PDecoder.mlmodelc",
  "G2PEncoder.mlmodelc",
  "g2p_vocab.json",
  "us_lexicon_cache.json",
];

/** One staged asset set, as doctor reports it and `install --plan` previews it. */
export interface KokoroAneComponent {
  label: string;
  path: string;
  note: string;
  /** Something is staged here — not that the set is complete. */
  exists: boolean;
  /** Required entries absent from disk; empty when the set is whole. */
  missing: string[];
  sizeBytes: number;
}

export interface KokoroAneOptions {
  platform?: string;
  arch?: string;
  homeDir?: string;
  cacheRoot?: string;
}

/**
 * The two sets `models/staging.rs::stage_fluidaudio_kokoro_assets` stages for any non-`ru` TTS
 * language. The Mandarin (`ANE-zh/`) sibling is deliberately not here: `--tts zh` is a
 * separate opt-in, and its bytes already show up under the cache report's Kokoro ANE root.
 *
 * Top-level existence on purpose, one notch weaker than `models/staging.rs::missing_kokoro_assets`.
 * That per-file check gates synthesis and must be exact; this one answers "is this install
 * whole" without mirroring ~40 file names into a second language for a diagnostic (#828).
 */
export function kokoroAneComponents(options: KokoroAneOptions = {}): KokoroAneComponent[] {
  if (!isDarwinArm64(options.platform, options.arch)) return [];
  const homeDir = options.homeDir ?? diagnosticHomeDir();
  const roots = { homeDir, cacheRoot: options.cacheRoot };

  return [
    {
      label: "TTS (Kokoro ANE)",
      path: kokoroAneDir(roots),
      note: "darwin-arm64 Kokoro synthesizes from here, not from the ONNX Kokoro cache",
      required: KOKORO_ANE_EN_REQUIRED,
    },
    {
      label: "TTS (Kokoro G2P)",
      path: kokoroG2pDir(homeDir),
      note: "shared English G2P; upstream pins this path, so it never moves into the Kesha cache",
      required: KOKORO_G2P_REQUIRED,
    },
  ].map(({ required, ...component }) => ({
    ...component,
    exists: existsSync(component.path),
    missing: required.filter((entry) => !existsSync(join(component.path, entry))),
    sizeBytes: dirSizeBytes(component.path),
  }));
}
