import { existsSync, statSync } from "fs";
import { humanBytes } from "./format";
import { dirname, join } from "path";
import { getEngineBinPath } from "./engine";
import { SIDECARS } from "./engine-install";
import { readInstalledEngineVersion } from "./engine-version-marker";
import { keshaCacheDir } from "./paths";
import { engineVersion, packageVersion } from "./package-info";
import {
  FLUID_KOKORO_CACHE_NOTE,
  fluidKokoroCachePath,
  isDarwinArm64,
} from "./fluid-kokoro-cache";

export interface InstallPlanOptions {
  noCache?: boolean;
  backend?: string;
  /** Resolved TTS language codes, e.g. ["en", "ru"]. */
  ttsLangs?: string[];
  vad?: boolean;
  diarize?: boolean;
}

interface PlanFile {
  relPath: string;
  sizeBytes: number;
}

interface PlanComponent {
  name: string;
  source: string;
  sizeBytes: number;
  cached: boolean;
  refresh: boolean;
  note?: string;
}

interface PlanWarmup {
  name: string;
  note: string;
}

interface ReleaseAssetSpec {
  assetName: string;
  sizeBytes: number;
}

// Mirrors the pinned runtime manifests so `kesha install --plan` works before
// the engine exists. Keep in sync with rust/src/models.rs and release assets.
const ASR_FILES: PlanFile[] = [
  { relPath: "models/parakeet-tdt-v3/encoder-model.onnx", sizeBytes: 41_770_866 },
  { relPath: "models/parakeet-tdt-v3/encoder-model.onnx.data", sizeBytes: 2_435_420_160 },
  { relPath: "models/parakeet-tdt-v3/decoder_joint-model.onnx", sizeBytes: 72_520_893 },
  { relPath: "models/parakeet-tdt-v3/nemo128.onnx", sizeBytes: 139_764 },
  { relPath: "models/parakeet-tdt-v3/vocab.txt", sizeBytes: 93_939 },
];

const LANG_ID_FILES: PlanFile[] = [
  { relPath: "models/lang-id-ecapa/lang-id-ecapa.onnx", sizeBytes: 759_814 },
  { relPath: "models/lang-id-ecapa/lang-id-ecapa.onnx.data", sizeBytes: 85_327_872 },
  { relPath: "models/lang-id-ecapa/labels.json", sizeBytes: 646 },
];

const VAD_FILES: PlanFile[] = [
  { relPath: "models/silero-vad/silero_vad.onnx", sizeBytes: 2_327_524 },
];

// klebster CharsiuG2P byt5-tiny ONNX export (CC-BY 4.0 — see NOTICES.md).
// 3 files enabling multilingual G2P for es/fr/it/pt Kokoro voices (#212).
const G2P_CHARSIU_FILES: PlanFile[] = [
  { relPath: "models/g2p/byt5-tiny/encoder_model.onnx", sizeBytes: 12_478_704 },
  { relPath: "models/g2p/byt5-tiny/decoder_model.onnx", sizeBytes: 11_983_268 },
  { relPath: "models/g2p/byt5-tiny/decoder_with_past_model.onnx", sizeBytes: 5_427_260 },
];

// Kokoro ONNX graph (shared by all Kokoro languages on non-darwin builds).
const KOKORO_GRAPH_FILE: PlanFile = { relPath: "models/kokoro-82m/model.onnx", sizeBytes: 325_532_387 };

// Per-language default voice files.
// Multilingual voice packs for es/fr/it/pt (#212).
// em_alex (es, male), ff_siwis (fr, female — only French voice in Kokoro v1.0),
// im_nicola (it, male), pm_alex (pt, male).
const KOKORO_VOICE_FILES: Record<string, PlanFile> = {
  en: { relPath: "models/kokoro-82m/voices/am_michael.bin", sizeBytes: 522_240 },
  es: { relPath: "models/kokoro-82m/voices/em_alex.bin", sizeBytes: 522_240 },
  fr: { relPath: "models/kokoro-82m/voices/ff_siwis.bin", sizeBytes: 522_240 },
  it: { relPath: "models/kokoro-82m/voices/im_nicola.bin", sizeBytes: 522_240 },
  pt: { relPath: "models/kokoro-82m/voices/pm_alex.bin", sizeBytes: 522_240 },
};

function kokoroPlanFiles(langs: string[]): PlanFile[] {
  const files: PlanFile[] = [KOKORO_GRAPH_FILE];
  for (const l of langs) {
    const v = KOKORO_VOICE_FILES[l];
    if (v) files.push(v);
  }
  return files;
}

const VOSK_RU_FILES: PlanFile[] = [
  { relPath: "models/vosk-ru/model.onnx", sizeBytes: 179_314_533 },
  { relPath: "models/vosk-ru/dictionary", sizeBytes: 101_431_118 },
  { relPath: "models/vosk-ru/config.json", sizeBytes: 1_518 },
  { relPath: "models/vosk-ru/bert/model.onnx", sizeBytes: 654_361_598 },
  { relPath: "models/vosk-ru/bert/vocab.txt", sizeBytes: 1_780_720 },
];

const DIARIZE_FILES: PlanFile[] = [
  { relPath: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Manifest.json", sizeBytes: 617 },
  {
    relPath: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/model.mlmodel",
    sizeBytes: 7_080_357,
  },
  {
    relPath: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/0-weight.bin",
    sizeBytes: 5_930_400,
  },
  {
    relPath: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/1-weight.bin",
    sizeBytes: 232_161_600,
  },
];

// The sidecar list (and the asset-name → installed-filename mapping) lives in
// SIDECARS in engine-install.ts; only the release-asset sizes are pinned here,
// like the model tables above.
const SIDECAR_ASSET_SIZES: Record<string, number> = {
  "say-avspeech-darwin-arm64": 63_056,
  "kesha-textlang-darwin-arm64": 57_648,
};

const DARWIN_SIDECARS = SIDECARS.map((s) => ({
  assetName: s.assetName,
  fileBasename: s.fileBasename,
  sizeBytes: SIDECAR_ASSET_SIZES[s.assetName] ?? 0,
}));

function sumFiles(files: PlanFile[]): number {
  return files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

function engineAssetForPlatform(): ReleaseAssetSpec | null {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { assetName: "kesha-engine-darwin-arm64", sizeBytes: 59_621_264 };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return { assetName: "kesha-engine-linux-x64", sizeBytes: 62_897_808 };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return { assetName: "kesha-engine-windows-x64.exe", sizeBytes: 63_126_528 };
  }
  return null;
}

function filesCached(cacheRoot: string, files: PlanFile[]): boolean {
  return files.every((file) => {
    const path = join(cacheRoot, file.relPath);
    return existsSync(path) && statSync(path).size > 0;
  });
}

function bundleComponent(
  cacheRoot: string,
  name: string,
  source: string,
  files: PlanFile[],
  refresh: boolean,
  note?: string,
): PlanComponent {
  return {
    name,
    source,
    sizeBytes: sumFiles(files),
    cached: filesCached(cacheRoot, files),
    refresh,
    note,
  };
}

export async function renderInstallPlan(options: InstallPlanOptions = {}): Promise<string> {
  const cacheRoot = keshaCacheDir();
  const binPath = getEngineBinPath();
  const engineDir = dirname(binPath);
  const noCache = options.noCache === true;
  const components: PlanComponent[] = [];
  const warmups: PlanWarmup[] = [];

  const engineAsset = engineAssetForPlatform();
  if (engineAsset) {
    const engineCached =
      existsSync(binPath) && readInstalledEngineVersion(binPath) === engineVersion;
    components.push({
      name: `Engine ${engineAsset.assetName}`,
      source: `GitHub release v${engineVersion}`,
      sizeBytes: engineAsset.sizeBytes,
      cached: engineCached,
      refresh: noCache,
      note:
        process.platform === "win32"
          ? "Windows x64 is currently blocked by the install path; see issue #216."
          : undefined,
    });
  } else {
    components.push({
      name: `Engine for ${process.platform} ${process.arch}`,
      source: "GitHub release",
      sizeBytes: 0,
      cached: false,
      refresh: false,
      note: "unsupported platform",
    });
  }

  if (isDarwinArm64()) {
    for (const sidecar of DARWIN_SIDECARS) {
      components.push({
        name: `Sidecar ${sidecar.assetName}`,
        source: `GitHub release v${engineVersion}`,
        sizeBytes: sidecar.sizeBytes,
        cached: existsSync(join(engineDir, sidecar.fileBasename)),
        refresh: noCache,
      });
    }
  }

  components.push(
    bundleComponent(
      cacheRoot,
      "ASR Parakeet TDT v3",
      "model cache",
      ASR_FILES,
      noCache,
      "required for speech-to-text",
    ),
  );
  components.push(
    bundleComponent(
      cacheRoot,
      "Audio language ID ECAPA",
      "model cache",
      LANG_ID_FILES,
      noCache,
      "required for --json, --toon, --format transcript, --lang, and --verbose language metadata",
    ),
  );

  const ttsLangs = options.ttsLangs ?? [];
  // Darwin ANE serves every non-ru language through Kokoro (en/es/fr/it/pt + the
  // ANE-only hi/ja/zh), so the warm-up gate mirrors engine-install.ts's
  // `some((l) => l !== "ru")`. The ONNX component, by contrast, only covers the
  // graph-backed en/es/fr/it/pt set (hi/ja/zh are darwin-only and rejected on ONNX).
  const wantsAnyKokoro = ttsLangs.some((l) => l !== "ru");
  const wantsOnnxKokoro = ttsLangs.some((l) => ["en", "es", "fr", "it", "pt"].includes(l));
  const wantsG2p = ttsLangs.some((l) => ["es", "fr", "it", "pt"].includes(l));
  const wantsRu = ttsLangs.includes("ru");

  if (ttsLangs.length > 0) {
    if (isDarwinArm64()) {
      if (wantsAnyKokoro) {
        warmups.push({
          name: "TTS Kokoro (ANE)",
          note: `${FLUID_KOKORO_CACHE_NOTE} (${fluidKokoroCachePath()})`,
        });
      }
      if (wantsRu) {
        components.push(
          bundleComponent(cacheRoot, "TTS Vosk RU", "model cache", VOSK_RU_FILES, noCache, "Russian ru-vosk-* voices"),
        );
      }
    } else {
      if (wantsOnnxKokoro) {
        components.push(
          bundleComponent(
            cacheRoot,
            "TTS Kokoro graph + voices",
            "model cache",
            kokoroPlanFiles(ttsLangs),
            noCache,
            `voices for ${ttsLangs.filter((l) => l !== "ru").join(", ")}`,
          ),
        );
      }
      if (wantsG2p) {
        components.push(
          bundleComponent(
            cacheRoot,
            "G2P CharsiuG2P byt5-tiny",
            "model cache",
            G2P_CHARSIU_FILES,
            noCache,
            "multilingual G2P for es/fr/it/pt (CC-BY 4.0)",
          ),
        );
      }
      if (wantsRu) {
        components.push(
          bundleComponent(cacheRoot, "TTS Vosk RU", "model cache", VOSK_RU_FILES, noCache, "Russian ru-vosk-* voices"),
        );
      }
    }
  }

  if (options.vad) {
    components.push(
      bundleComponent(
        cacheRoot,
        "VAD Silero v5",
        "model cache",
        VAD_FILES,
        noCache,
        "long-audio preprocessing",
      ),
    );
  }

  if (options.diarize) {
    components.push(
      bundleComponent(
        cacheRoot,
        "Diarization Sortformer",
        "model cache",
        DIARIZE_FILES,
        noCache,
        isDarwinArm64()
          ? "speaker labels for --speakers"
          : "darwin-arm64 only; install will reject this flag on the current platform",
      ),
    );
  }

  const coldBytes = components.reduce((sum, component) => sum + component.sizeBytes, 0);
  const expectedNetworkBytes = components.reduce((sum, component) => {
    if (component.cached && !component.refresh) return sum;
    return sum + component.sizeBytes;
  }, 0);
  const status = (component: PlanComponent) => {
    if (component.refresh) return "refresh";
    return component.cached ? "cached" : "needed";
  };

  const lines = [
    "Kesha install plan",
    "",
    `Package: @drakulavich/kesha-voice-kit ${packageVersion}`,
    `Engine release: v${engineVersion}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Cache: ${cacheRoot}`,
    `Engine binary: ${binPath}`,
    options.backend ? `Requested backend: ${options.backend}` : "Requested backend: auto",
    "",
    "Components:",
  ];

  for (const component of components) {
    lines.push(
      `  - ${component.name}: ${humanBytes(component.sizeBytes)} (${component.sizeBytes} bytes, ${status(component)}, ${component.source})`,
    );
    if (component.note) lines.push(`    ${component.note}`);
  }

  if (warmups.length > 0) {
    lines.push("", "Warm-ups:");
    for (const warmup of warmups) {
      lines.push(`  - ${warmup.name}: ${warmup.note}`);
    }
  }

  lines.push(
    "",
    "Totals:",
    `  Cold-cache Kesha-managed download: ${humanBytes(coldBytes)}`,
    `  Expected Kesha-managed network for this run: ${humanBytes(expectedNetworkBytes)}`,
    "",
    "Install behavior:",
    "  - No files are downloaded or changed by --plan.",
    "  - install verifies model SHA-256 hashes and reuses matching cached files unless --no-cache is set.",
    isDarwinArm64()
      ? "  - macOS install signs/unquarantines downloaded binaries for Gatekeeper."
      : "  - No macOS Gatekeeper signing step on this platform.",
    "  - install warms the ASR backend after downloads; CoreML warm-up is typically 20-30 s, ONNX warm-up is about 500 ms.",
  );

  if (ttsLangs.length > 0 && wantsAnyKokoro && isDarwinArm64()) {
    lines.push(
      "  - --tts also warms FluidAudio Kokoro CoreML; FluidAudio may download/compile its own Kokoro cache on first use.",
    );
  }

  const command = [
    "kesha",
    "install",
    options.noCache ? "--no-cache" : "",
    options.backend === "coreml" ? "--coreml" : "",
    options.backend === "onnx" ? "--onnx" : "",
    ...(ttsLangs.length > 0 ? ["--tts", ...ttsLangs] : []),
    options.vad ? "--vad" : "",
    options.diarize ? "--diarize" : "",
  ].filter(Boolean);
  lines.push("", `Run: ${command.join(" ")}`, "");

  return `${lines.join("\n")}\n`;
}
