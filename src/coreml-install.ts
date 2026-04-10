import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, chmodSync } from "fs";
import { getCoreMLBinPath } from "./coreml";
import { log } from "./log";
import { streamResponseToFile } from "./progress";

const COREML_BINARY_NAME = "parakeet-coreml-darwin-arm64";
const GITHUB_REPO = "drakulavich/parakeet-cli";

export type CoreMLInstallState = "missing" | "binary-only" | "ready" | "stale-binary";
export type CoreMLBinaryInstallState = "ready" | "models-missing";

export interface CoreMLBinaryCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CoreMLBinaryRunner {
  probeCapabilities(binPath: string): CoreMLBinaryCommandResult;
  downloadModels(binPath: string): CoreMLBinaryCommandResult;
}

export interface CoreMLOutputWriter {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CoreMLBinaryCapabilities {
  protocolVersion: number;
  installState: CoreMLBinaryInstallState;
  supportedCommands: {
    checkInstall: boolean;
    downloadOnly: boolean;
  };
}

const defaultOutputWriter: CoreMLOutputWriter = {
  stdout(message) {
    process.stdout.write(message);
  },
  stderr(message) {
    process.stderr.write(message);
  },
};

export function createCoreMLBinaryRunner(
  spawnSync: typeof Bun.spawnSync = Bun.spawnSync,
): CoreMLBinaryRunner {
  function runCommand(binPath: string, flag: string): CoreMLBinaryCommandResult {
    const proc = spawnSync([binPath, flag], {
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  }

  return {
    probeCapabilities(binPath) {
      return runCommand(binPath, "--capabilities-json");
    },
    downloadModels(binPath) {
      return runCommand(binPath, "--download-only");
    },
  };
}

const defaultCoreMLBinaryRunner = createCoreMLBinaryRunner();

export function getCoreMLSupportDir(): string {
  return join(homedir(), ".cache", "parakeet", "coreml");
}

export function getCoreMLDownloadURL(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${COREML_BINARY_NAME}`;
}

export function getCoreMLLatestDownloadURL(): string {
  return `https://github.com/${GITHUB_REPO}/releases/latest/download/${COREML_BINARY_NAME}`;
}

export function isUnreleasedVersion(version: string): boolean {
  return version === "0.0.0" || version.includes("-");
}

export function getCoreMLBinaryDownloadCandidates(version: string): string[] {
  const versionUrl = getCoreMLDownloadURL(version);
  if (isUnreleasedVersion(version)) {
    return [getCoreMLLatestDownloadURL(), versionUrl];
  }
  return [versionUrl];
}

export function getCoreMLInstallState(opts?: {
  binPath?: string;
  exists?: (path: string) => boolean;
  verifyReady?: (binPath: string) => CoreMLInstallState;
}): CoreMLInstallState {
  const binPath = opts?.binPath ?? getCoreMLBinPath();
  const fileExists = opts?.exists ?? existsSync;
  const verifyReady = opts?.verifyReady;

  if (!fileExists(binPath)) {
    return "missing";
  }

  if (!verifyReady) {
    return "binary-only";
  }

  return verifyReady(binPath);
}

export function planCoreMLInstall(
  state: CoreMLInstallState,
  noCache = false,
): { downloadBinary: boolean; downloadModels: boolean } {
  if (noCache) {
    return { downloadBinary: true, downloadModels: true };
  }

  switch (state) {
    case "missing":
      return { downloadBinary: true, downloadModels: true };
    case "binary-only":
      return { downloadBinary: false, downloadModels: true };
    case "ready":
      return { downloadBinary: false, downloadModels: false };
    case "stale-binary":
      return { downloadBinary: true, downloadModels: true };
  }
}

export function parseCoreMLBinaryCapabilities(stdout: string): CoreMLBinaryCapabilities | null {
  try {
    const parsed = JSON.parse(stdout) as Partial<CoreMLBinaryCapabilities>;
    if (parsed.protocolVersion !== 1) {
      return null;
    }
    if (parsed.installState !== "ready" && parsed.installState !== "models-missing") {
      return null;
    }
    if (!parsed.supportedCommands) {
      return null;
    }
    if (parsed.supportedCommands.checkInstall !== true || parsed.supportedCommands.downloadOnly !== true) {
      return null;
    }

    return {
      protocolVersion: parsed.protocolVersion,
      installState: parsed.installState,
      supportedCommands: parsed.supportedCommands,
    };
  } catch {
    return null;
  }
}

export function classifyCoreMLInstallProbe(exitCode: number, stdout: string): CoreMLInstallState {
  if (exitCode !== 0) {
    return "stale-binary";
  }

  const capabilities = parseCoreMLBinaryCapabilities(stdout);
  if (!capabilities) {
    return "stale-binary";
  }

  return capabilities.installState === "ready" ? "ready" : "binary-only";
}

async function fetchCoreMLBinary(): Promise<Response> {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const version = typeof pkg.version === "string" ? pkg.version : "unknown";

  let lastStatus: number | null = null;
  for (const url of getCoreMLBinaryDownloadCandidates(version)) {
    const res = await fetch(url, { redirect: "follow" });
    if (res.ok) {
      return res;
    }
    lastStatus = res.status;
  }

  throw new Error(
    `Failed to download CoreML binary${lastStatus ? ` (HTTP ${lastStatus})` : ""}\n  Requested package version: ${version}\n  Fix: Check https://github.com/drakulavich/parakeet-cli/releases for available versions\n       Or install the ONNX backend instead: parakeet install --onnx`,
  );
}

export function getCoreMLInstallStatus(
  binPath: string,
  runner: CoreMLBinaryRunner = defaultCoreMLBinaryRunner,
): CoreMLInstallState {
  const probe = runner.probeCapabilities(binPath);
  return classifyCoreMLInstallProbe(probe.exitCode, probe.stdout);
}

export async function ensureCoreMLModels(
  binPath: string,
  runner: CoreMLBinaryRunner = defaultCoreMLBinaryRunner,
  output: CoreMLOutputWriter = defaultOutputWriter,
): Promise<void> {
  const download = runner.downloadModels(binPath);

  if (download.stderr) {
    output.stderr(download.stderr);
  }
  if (download.stdout) {
    output.stdout(download.stdout);
  }

  if (download.exitCode !== 0) {
    const detail = download.stderr.trim();
    throw new Error(detail ? `Failed to download CoreML models: ${detail}` : "Failed to download CoreML models");
  }
}

export async function downloadCoreML(
  noCache = false,
  opts?: {
    runner?: CoreMLBinaryRunner;
    output?: CoreMLOutputWriter;
  },
): Promise<string> {
  const binPath = getCoreMLBinPath();
  const runner = opts?.runner ?? defaultCoreMLBinaryRunner;
  const output = opts?.output ?? defaultOutputWriter;
  const state = getCoreMLInstallState({
    binPath,
    verifyReady: noCache ? undefined : (path) => getCoreMLInstallStatus(path, runner),
  });
  const plan = planCoreMLInstall(state, noCache);

  if (!plan.downloadBinary && !plan.downloadModels) {
    log.success("CoreML backend already installed.");
    return binPath;
  }

  if (plan.downloadBinary) {
    const res = await fetchCoreMLBinary();
    mkdirSync(dirname(binPath), { recursive: true });
    await streamResponseToFile(res, binPath, "parakeet-coreml binary");
    chmodSync(binPath, 0o755);
  }

  if (plan.downloadModels) {
    await ensureCoreMLModels(binPath, runner, output);
  }

  log.success("CoreML backend installed successfully.");
  return binPath;
}
