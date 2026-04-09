import { isMacArm64, getCoreMLBinPath } from "./coreml";
import { isModelCached, getModelDir } from "./onnx-install";
import { getCoreMLInstallState, getCoreMLInstallStatus, getCoreMLSupportDir, type CoreMLInstallState } from "./coreml-install";
import { log } from "./log";
import pc from "picocolors";

export function formatStatusLine(
  label: string,
  path: string | null,
  installed: boolean,
  missingLabel = "not installed",
): string {
  const status = installed ? pc.green("✓") : pc.red(`✗ ${missingLabel}`);
  const pathStr = path ?? "";
  const padding = " ".repeat(Math.max(1, 50 - label.length - pathStr.length));
  return `  ${label}:${pathStr ? `   ${pathStr}` : ""}${padding}${status}`;
}

export interface StatusInfo {
  onnx: boolean;
  coreml: CoreMLInstallState | "n/a";
  ffmpeg: boolean;
}

export function collectSuggestions(info: StatusInfo): string[] {
  const suggestions: string[] = [];

  if (info.coreml === "missing" || info.coreml === "stale-binary") {
    suggestions.push(`Run "parakeet install --coreml" to install the CoreML backend.`);
  } else if (info.coreml === "binary-only") {
    suggestions.push(`Run "parakeet install --coreml" to download CoreML models.`);
  }

  if (!info.onnx) {
    suggestions.push(`Run "parakeet install --onnx" to install the ONNX backend.`);
  }

  if (!info.ffmpeg) {
    suggestions.push(`Install ffmpeg for ONNX audio conversion (see "parakeet install" output for instructions).`);
  }

  return suggestions;
}

export interface StatusDeps {
  isMacArm64: () => boolean;
  getCoreMLBinPath: () => string;
  getCoreMLState: (binPath: string) => CoreMLInstallState;
  getCoreMLSupportDir: () => string;
  isModelCached: () => boolean;
  getModelDir: () => string;
  whichFfmpeg: () => string | null;
  bunVersion: string;
  platform: string;
}

function defaultDeps(): StatusDeps {
  return {
    isMacArm64,
    getCoreMLBinPath,
    getCoreMLState: (binPath) => getCoreMLInstallState({
      binPath,
      verifyReady: (path) => getCoreMLInstallStatus(path),
    }),
    getCoreMLSupportDir,
    isModelCached,
    getModelDir,
    whichFfmpeg: () => Bun.which("ffmpeg"),
    bunVersion: Bun.version,
    platform: `${process.platform} ${process.arch}`,
  };
}

export async function showStatus(deps?: Partial<StatusDeps>): Promise<void> {
  const d = { ...defaultDeps(), ...deps };

  const isMac = d.isMacArm64();

  // CoreML status
  let coremlState: CoreMLInstallState | "n/a" = "n/a";
  if (isMac) {
    const binPath = d.getCoreMLBinPath();
    try {
      coremlState = d.getCoreMLState(binPath);
    } catch {
      coremlState = "missing";
    }

    log.info("CoreML (macOS Apple Silicon):");
    const binInstalled = coremlState !== "missing";
    log.info(formatStatusLine("Binary", binInstalled ? binPath : null, binInstalled));

    const modelsInstalled = coremlState === "ready";
    const modelDir = d.getCoreMLSupportDir();
    log.info(formatStatusLine("Models", modelsInstalled ? modelDir : null, modelsInstalled));
    log.info("");
  }

  // ONNX status
  const modelDir = d.getModelDir();
  const onnxInstalled = d.isModelCached();
  log.info("ONNX:");
  log.info(formatStatusLine("Models", onnxInstalled ? modelDir : null, onnxInstalled));
  log.info("");

  // ffmpeg
  const ffmpegPath = d.whichFfmpeg();
  log.info(formatStatusLine("ffmpeg", ffmpegPath, !!ffmpegPath, "not found"));

  // Runtime info
  log.info(formatStatusLine("Runtime", `Bun ${d.bunVersion}`, true));
  log.info(formatStatusLine("Platform", d.platform, true));
  log.info("");

  // Suggestions
  const suggestions = collectSuggestions({
    onnx: onnxInstalled,
    coreml: coremlState,
    ffmpeg: !!ffmpegPath,
  });

  for (const suggestion of suggestions) {
    log.warn(suggestion);
  }
}
