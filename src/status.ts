import { isMacArm64, getCoreMLBinPath } from "./coreml";
import { isModelCached, getModelDir } from "./onnx-install";
import { getCoreMLInstallState, getCoreMLInstallStatus, getCoreMLSupportDir, type CoreMLInstallState } from "./coreml-install";
import { log } from "./log";
import pc from "picocolors";

export type StatusCoreMLState = CoreMLInstallState | "n/a" | "probe-failed";
export type StatusPlatform = "mac-arm64" | "other";

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
  coreml: StatusCoreMLState;
  ffmpeg: boolean;
  platform: StatusPlatform;
}

export function collectSuggestions(info: StatusInfo): string[] {
  const suggestions: string[] = [];

  if (info.platform === "mac-arm64") {
    if (info.coreml === "missing") {
      suggestions.push(`Run "parakeet install --coreml" to install the CoreML backend.`);
    } else if (info.coreml === "binary-only") {
      suggestions.push(`Run "parakeet install --coreml" to download CoreML models.`);
    } else if (info.coreml === "stale-binary") {
      suggestions.push(`Run "parakeet install --coreml --no-cache" to refresh the incompatible CoreML binary.`);
    } else if (info.coreml === "probe-failed") {
      suggestions.push(`Run "parakeet install --coreml --no-cache" to refresh the CoreML backend and restore status checks.`);
    }
    return suggestions;
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

function getCoreMLBinaryDisplay(state: StatusCoreMLState): { installed: boolean; missingLabel: string } {
  switch (state) {
    case "ready":
    case "binary-only":
      return { installed: true, missingLabel: "not installed" };
    case "stale-binary":
      return { installed: false, missingLabel: "stale binary" };
    case "probe-failed":
      return { installed: false, missingLabel: "probe failed" };
    case "missing":
    case "n/a":
      return { installed: false, missingLabel: "not installed" };
  }
}

function getCoreMLModelsDisplay(state: StatusCoreMLState): { installed: boolean; missingLabel: string } {
  switch (state) {
    case "ready":
      return { installed: true, missingLabel: "not installed" };
    case "stale-binary":
      return { installed: false, missingLabel: "reinstall required" };
    case "probe-failed":
      return { installed: false, missingLabel: "status unknown" };
    case "binary-only":
    case "missing":
    case "n/a":
      return { installed: false, missingLabel: "not installed" };
  }
}

export async function showStatus(deps?: Partial<StatusDeps>): Promise<void> {
  const d = { ...defaultDeps(), ...deps };

  const isMac = d.isMacArm64();
  const platform: StatusPlatform = isMac ? "mac-arm64" : "other";

  // CoreML status
  let coremlState: StatusCoreMLState = "n/a";
  let coremlProbeError: string | null = null;
  if (isMac) {
    const binPath = d.getCoreMLBinPath();
    try {
      coremlState = d.getCoreMLState(binPath);
    } catch (error: unknown) {
      coremlState = "probe-failed";
      coremlProbeError = error instanceof Error ? error.message : String(error);
    }

    log.info("CoreML (macOS Apple Silicon):");
    const binaryDisplay = getCoreMLBinaryDisplay(coremlState);
    log.info(formatStatusLine("Binary", coremlState === "missing" ? null : binPath, binaryDisplay.installed, binaryDisplay.missingLabel));

    const modelsDisplay = getCoreMLModelsDisplay(coremlState);
    const modelDir = d.getCoreMLSupportDir();
    const modelsPath = (coremlState === "ready" || coremlState === "stale-binary" || coremlState === "probe-failed") ? modelDir : null;
    log.info(formatStatusLine("Models", modelsPath, modelsDisplay.installed, modelsDisplay.missingLabel));
    log.info("");

    if (coremlProbeError) {
      log.warn(`CoreML status probe failed: ${coremlProbeError}`);
    }
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
    platform,
  });

  for (const suggestion of suggestions) {
    log.warn(suggestion);
  }
}
