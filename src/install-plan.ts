import { existsSync, statSync } from "fs";
import { humanBytes } from "./format";
import { dirname, join } from "path";
import { getEngineBinPath, getEngineCapabilities } from "./engine";
import { SIDECARS } from "./engine-install";
import { engineTarget } from "./engine-targets";
import { readInstalledEngineVersion } from "./engine-version-marker";
import { keshaCacheDir } from "./paths";
import { engineVersion, packageVersion } from "./package-info";
import {
  FLUID_KOKORO_CACHE_NOTE,
  fluidKokoroCachePath,
  isDarwinArm64,
} from "./fluid-kokoro-cache";
import modelPlan from "../model-plan.json" with { type: "json" };
import {
  FLUID_ASR_CACHE_NOTE,
  fluidAsrCachePath,
  fluidAsrCacheReady,
  isCoremlBackend,
} from "./fluid-asr-cache";

export interface InstallPlanOptions {
  noCache?: boolean;
  backend?: string;
  /** Resolved TTS language codes, e.g. ["en", "ru"]. */
  ttsLangs?: string[];
  vad?: boolean;
  diarize?: boolean;
  /** `--engine-version`; the plan must preview the release the real install would fetch. */
  engineVersion?: string;
}

interface PlanFile {
  relPath: string;
  sizeBytes: number;
}

interface ModelPlan {
  asr: PlanFile[];
  langId: PlanFile[];
  vad: PlanFile[];
  g2pCharsiu: PlanFile[];
  kokoroGraph: PlanFile;
  kokoroVoices: Record<string, PlanFile>;
  voskRu: PlanFile[];
  diarize: PlanFile[];
}

interface PlanComponent {
  name: string;
  source: string;
  sizeBytes: number;
  cached: boolean;
  refresh: boolean;
  note?: string;
  /** Fetched by a backend into its own cache — excluded from the Kesha-managed totals. */
  external?: boolean;
}

interface PlanWarmup {
  name: string;
  note: string;
}

interface ReleaseAssetSpec {
  assetName: string;
  sizeBytes: number;
}

// Shared plan metadata keeps `kesha install --plan` usable before the engine
// exists. Rust tests guard these cache paths against its pinned manifests.
const plan: ModelPlan = modelPlan;
const {
  asr: ASR_FILES,
  langId: LANG_ID_FILES,
  vad: VAD_FILES,
  g2pCharsiu: G2P_CHARSIU_FILES,
  kokoroGraph: KOKORO_GRAPH_FILE,
  kokoroVoices: KOKORO_VOICE_FILES,
  voskRu: VOSK_RU_FILES,
  diarize: DIARIZE_FILES,
} = plan;

function kokoroPlanFiles(langs: string[]): PlanFile[] {
  const files: PlanFile[] = [KOKORO_GRAPH_FILE];
  for (const l of langs) {
    const v = KOKORO_VOICE_FILES[l];
    if (v) files.push(v);
  }
  return files;
}

// The sidecar list (and the asset-name → installed-filename mapping) lives in
// SIDECARS in engine-install.ts; only the release-asset sizes are pinned here,
// like the model tables above.
const SIDECAR_ASSET_SIZES: Record<string, number> = {
  "say-avspeech-darwin-arm64": 63_056,
  "kesha-textlang-darwin-arm64": 57_648,
};

const DARWIN_SIDECARS = SIDECARS.map((s) => {
  const sizeBytes = SIDECAR_ASSET_SIZES[s.assetName];
  if (sizeBytes === undefined) {
    // Fail fast at module load: a sidecar added to SIDECARS without a size
    // entry here would otherwise silently render as "0 B" in the plan.
    throw new Error(
      `install-plan: missing release-asset size for sidecar "${s.assetName}"; add it to SIDECAR_ASSET_SIZES`,
    );
  }
  return { assetName: s.assetName, fileBasename: s.fileBasename, sizeBytes };
});

function sumFiles(files: PlanFile[]): number {
  return files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

function engineAssetForPlatform(): ReleaseAssetSpec | null {
  const target = engineTarget();
  return target && { assetName: target.assetName, sizeBytes: target.sizeBytes };
}

function filesCached(cacheRoot: string, files: PlanFile[]): boolean {
  return files.every((file) => {
    const path = join(cacheRoot, file.relPath);
    return existsSync(path) && statSync(path).size > 0;
  });
}

function bundleComponent(input: {
  cacheRoot: string;
  name: string;
  source: string;
  files: PlanFile[];
  refresh: boolean;
  note?: string;
}): PlanComponent {
  return {
    name: input.name,
    source: input.source,
    sizeBytes: sumFiles(input.files),
    cached: filesCached(input.cacheRoot, input.files),
    refresh: input.refresh,
    note: input.note,
  };
}

/**
 * A CoreML engine cannot read the ONNX weights, so quoting their 2.43 GB would
 * promise a download that never happens. FluidAudio fetches its own bundle during
 * the install warm-up instead — still a cost, so it is named rather than dropped (#684).
 *
 * Measured from `parakeet-tdt-0.6b-v3`, the directory the current FluidAudio actually
 * loads. A `…-v3-coreml` sibling may also exist from earlier versions; counting it here
 * would overstate the plan against what `status --disk` then reports. An estimate, not a
 * manifest sum — rendered as approximate.
 */
const FLUID_ASR_BUNDLE_BYTES = 473 * 1024 * 1024;

/**
 * An explicit `--coreml` / `--onnx` wins. Otherwise ask the installed engine, so a custom
 * `KESHA_ENGINE_BIN` is planned for what it actually is rather than what the host usually
 * ships (#684). The probe is optional: `--plan` must still work before any engine exists,
 * and `isCoremlBackend` falls back to the platform when it yields nothing.
 */
async function planBackendIsCoreml(options: InstallPlanOptions): Promise<boolean> {
  if (options.backend === "coreml") return true;
  if (options.backend === "onnx") return false;
  const probed = await getEngineCapabilities().catch(() => null);
  return isCoremlBackend(probed?.backend);
}

function fluidAsrComponent(): PlanComponent {
  return {
    name: "ASR Parakeet TDT v3 (CoreML)",
    source: "FluidAudio cache",
    sizeBytes: FLUID_ASR_BUNDLE_BYTES,
    cached: fluidAsrCacheReady(fluidAsrCachePath()),
    // `--no-cache` is a Kesha-cache flag; FluidAudio's bundle is not re-fetched by it.
    refresh: false,
    external: true,
    note: FLUID_ASR_CACHE_NOTE,
  };
}

function engineIsCached(binPath: string, version: string): boolean {
  return existsSync(binPath) && readInstalledEngineVersion(binPath) === version;
}

function buildEngineComponent(
  noCache: boolean,
  version: string,
  engineCached: boolean,
): PlanComponent {
  const engineAsset = engineAssetForPlatform();
  if (engineAsset) {
    return {
      name: `Engine ${engineAsset.assetName}`,
      source: `GitHub release v${version}`,
      sizeBytes: engineAsset.sizeBytes,
      cached: engineCached,
      refresh: noCache,
    };
  }
  return {
    name: `Engine for ${process.platform} ${process.arch}`,
    source: "GitHub release",
    sizeBytes: 0,
    cached: false,
    refresh: false,
    note: "unsupported platform",
  };
}

function buildSidecarComponents(
  engineDir: string,
  noCache: boolean,
  version: string,
  engineCached: boolean,
): PlanComponent[] {
  if (!isDarwinArm64()) return [];
  return DARWIN_SIDECARS.map((sidecar) => ({
    name: `Sidecar ${sidecar.assetName}`,
    source: `GitHub release v${version}`,
    sizeBytes: sidecar.sizeBytes,
    // A cold engine fetch re-downloads every sidecar; only a cache hit tops up the missing ones.
    cached: engineCached && existsSync(join(engineDir, sidecar.fileBasename)),
    refresh: noCache,
  }));
}

function buildTtsComponents(
  cacheRoot: string,
  ttsLangs: string[],
  noCache: boolean,
): { components: PlanComponent[]; warmups: PlanWarmup[]; wantsAnyKokoro: boolean } {
  if (ttsLangs.length === 0) return { components: [], warmups: [], wantsAnyKokoro: false };

  // Darwin ANE serves every non-ru language through Kokoro (en/es/fr/it/pt + the
  // ANE-only hi/ja/zh), so the warm-up gate mirrors engine-install.ts's
  // `some((l) => l !== "ru")`. The ONNX component, by contrast, only covers the
  // graph-backed en/es/fr/it/pt set (hi/ja/zh are darwin-only and rejected on ONNX).
  const wantsAnyKokoro = ttsLangs.some((l) => l !== "ru");
  const wantsOnnxKokoro = ttsLangs.some((l) => ["en", "es", "fr", "it", "pt"].includes(l));
  const wantsG2p = ttsLangs.some((l) => ["es", "fr", "it", "pt"].includes(l));
  const wantsRu = ttsLangs.includes("ru");

  const components: PlanComponent[] = [];
  const warmups: PlanWarmup[] = [];

  if (isDarwinArm64()) {
    if (wantsAnyKokoro) {
      warmups.push({
        name: "TTS Kokoro (ANE)",
        note: `${FLUID_KOKORO_CACHE_NOTE} (${fluidKokoroCachePath()})`,
      });
    }
  } else {
    if (wantsOnnxKokoro) {
      components.push(
        bundleComponent({
          cacheRoot,
          name: "TTS Kokoro graph + voices",
          source: "model cache",
          files: kokoroPlanFiles(ttsLangs),
          refresh: noCache,
          note: `voices for ${ttsLangs.filter((l) => l !== "ru").join(", ")}`,
        }),
      );
    }
    if (wantsG2p) {
      components.push(
        bundleComponent({
          cacheRoot,
          name: "G2P CharsiuG2P byt5-tiny",
          source: "model cache",
          files: G2P_CHARSIU_FILES,
          refresh: noCache,
          note: "multilingual G2P for es/fr/it/pt (CC-BY 4.0)",
        }),
      );
    }
  }

  // Vosk RU is needed on both darwin and non-darwin builds.
  if (wantsRu) {
    components.push(
      bundleComponent({
        cacheRoot,
        name: "TTS Vosk RU",
        source: "model cache",
        files: VOSK_RU_FILES,
        refresh: noCache,
        note: "Russian ru-vosk-* voices",
      }),
    );
  }

  return { components, warmups, wantsAnyKokoro };
}

function assembleComponents(input: {
  cacheRoot: string;
  binPath: string;
  engineDir: string;
  noCache: boolean;
  options: InstallPlanOptions;
  coreml: boolean;
  version: string;
  ttsComponents: PlanComponent[];
}): PlanComponent[] {
  const { cacheRoot, noCache, options } = input;
  const modelBundle = (name: string, files: PlanFile[], note: string) =>
    bundleComponent({ cacheRoot, name, source: "model cache", files, refresh: noCache, note });

  const engineCached = engineIsCached(input.binPath, input.version);
  const components: PlanComponent[] = [
    buildEngineComponent(noCache, input.version, engineCached),
    ...buildSidecarComponents(input.engineDir, noCache, input.version, engineCached),
    input.coreml
      ? fluidAsrComponent()
      : modelBundle("ASR Parakeet TDT v3", ASR_FILES, "required for speech-to-text"),
    modelBundle(
      "Audio language ID ECAPA",
      LANG_ID_FILES,
      "required for --json, --toon, --format transcript, --lang, and --verbose language metadata",
    ),
    ...input.ttsComponents,
  ];
  // #768: --diarize implies VAD — speaker labels attach to VAD-windowed segments.
  if (options.vad || options.diarize) {
    components.push(
      modelBundle(
        "VAD Silero v5",
        VAD_FILES,
        options.vad
          ? "long-audio preprocessing"
          : "long-audio preprocessing; --diarize installs it to window audio into labelable segments",
      ),
    );
  }
  if (options.diarize) {
    components.push(
      modelBundle(
        "Diarization Sortformer",
        DIARIZE_FILES,
        isDarwinArm64()
          ? "speaker labels for --speakers"
          : "darwin-arm64 only; install will reject this flag on the current platform",
      ),
    );
  }
  return components;
}

function renderHeader(
  cacheRoot: string,
  binPath: string,
  backend: string | undefined,
  version: string,
): string[] {
  const pinNote = version === engineVersion ? "" : ` (overrides the pinned v${engineVersion})`;
  return [
    "Kesha install plan",
    "",
    `Package: @drakulavich/kesha-voice-kit ${packageVersion}`,
    `Engine release: v${version}${pinNote}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Cache: ${cacheRoot}`,
    `Engine binary: ${binPath}`,
    backend ? `Requested backend: ${backend}` : "Requested backend: auto",
    "",
    "Components:",
  ];
}

function renderComponentLines(components: PlanComponent[]): string[] {
  const status = (c: PlanComponent) => (c.refresh ? "refresh" : c.cached ? "cached" : "needed");
  const lines: string[] = [];
  for (const c of components) {
    const size = c.external ? `~${humanBytes(c.sizeBytes)}` : humanBytes(c.sizeBytes);
    const detail = c.external ? "approximate" : `${c.sizeBytes} bytes`;
    lines.push(`  - ${c.name}: ${size} (${detail}, ${status(c)}, ${c.source})`);
    if (c.note) lines.push(`    ${c.note}`);
  }
  return lines;
}

function renderWarmupLines(warmups: PlanWarmup[]): string[] {
  if (warmups.length === 0) return [];
  return ["", "Warm-ups:", ...warmups.map((w) => `  - ${w.name}: ${w.note}`)];
}

function renderTotalLines(components: PlanComponent[]): string[] {
  // External components are fetched by a backend into its own cache, so they cannot
  // sit under a total labelled "Kesha-managed" — they get their own line (#684).
  const managed = components.filter((c) => !c.external);
  const external = components.filter((c) => c.external);
  const coldBytes = managed.reduce((sum, c) => sum + c.sizeBytes, 0);
  const expectedNetworkBytes = managed.reduce((sum, c) => (c.cached && !c.refresh ? sum : sum + c.sizeBytes), 0);
  const lines = [
    "",
    "Totals:",
    `  Cold-cache Kesha-managed download: ${humanBytes(coldBytes)}`,
    `  Expected Kesha-managed network for this run: ${humanBytes(expectedNetworkBytes)}`,
  ];
  const externalPending = external.reduce((sum, c) => (c.cached ? sum : sum + c.sizeBytes), 0);
  if (externalPending > 0) {
    lines.push(
      `  Additionally fetched by the backend into its own cache: ~${humanBytes(externalPending)}`,
    );
  }
  return lines;
}

function renderBehaviorLines(ttsLangs: string[], wantsAnyKokoro: boolean): string[] {
  const lines = [
    "",
    "Install behavior:",
    "  - No files are downloaded or changed by --plan.",
    "  - install verifies model SHA-256 hashes and reuses matching cached files unless --no-cache is set.",
    isDarwinArm64()
      ? "  - macOS install signs/unquarantines downloaded binaries for Gatekeeper."
      : "  - No macOS Gatekeeper signing step on this platform.",
    "  - install warms the ASR backend after downloads; CoreML warm-up is typically 20-30 s, ONNX warm-up is about 500 ms.",
  ];
  if (ttsLangs.length > 0 && wantsAnyKokoro && isDarwinArm64()) {
    lines.push(
      "  - --tts also warms FluidAudio Kokoro CoreML; FluidAudio may download/compile its own Kokoro cache on first use.",
    );
  }
  return lines;
}

/** Argv of the `kesha install` invocation a plan describes. Shared with `kesha init`, whose suggestions must stay in step with it. */
export function installCommandTokens(
  options: InstallPlanOptions,
  ttsLangs: string[],
): string[] {
  return [
    "kesha",
    "install",
    ...(options.engineVersion ? ["--engine-version", options.engineVersion] : []),
    options.noCache ? "--no-cache" : "",
    options.backend === "coreml" ? "--coreml" : "",
    options.backend === "onnx" ? "--onnx" : "",
    ...(ttsLangs.length > 0 ? ["--tts", ...ttsLangs] : []),
    options.vad ? "--vad" : "",
    options.diarize ? "--diarize" : "",
  ].filter(Boolean);
}

/** Reconstructs the `kesha install` invocation this plan describes, so users can copy it verbatim. */
export function buildInstallCommand(options: InstallPlanOptions, ttsLangs: string[]): string {
  return installCommandTokens(options, ttsLangs).join(" ");
}

function renderFooter(input: {
  components: PlanComponent[];
  warmups: PlanWarmup[];
  ttsLangs: string[];
  wantsAnyKokoro: boolean;
  options: InstallPlanOptions;
}): string[] {
  return [
    ...renderWarmupLines(input.warmups),
    ...renderTotalLines(input.components),
    ...renderBehaviorLines(input.ttsLangs, input.wantsAnyKokoro),
    "",
    `Run: ${buildInstallCommand(input.options, input.ttsLangs)}`,
    "",
  ];
}

export async function renderInstallPlan(options: InstallPlanOptions = {}): Promise<string> {
  const cacheRoot = keshaCacheDir();
  const binPath = getEngineBinPath();
  const engineDir = dirname(binPath);
  const noCache = options.noCache === true;
  const ttsLangs = options.ttsLangs ?? [];

  const version = options.engineVersion ?? engineVersion;

  const tts = buildTtsComponents(cacheRoot, ttsLangs, noCache);
  const coreml = await planBackendIsCoreml(options);
  const components = assembleComponents({
    cacheRoot,
    binPath,
    engineDir,
    noCache,
    options,
    coreml,
    version,
    ttsComponents: tts.components,
  });

  const lines = [
    ...renderHeader(cacheRoot, binPath, options.backend, version),
    ...renderComponentLines(components),
    ...renderFooter({
      components,
      warmups: tts.warmups,
      ttsLangs,
      wantsAnyKokoro: tts.wantsAnyKokoro,
      options,
    }),
  ];

  return `${lines.join("\n")}\n`;
}
