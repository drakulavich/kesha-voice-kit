import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, chmodSync } from "fs";
import { getCoreMLBinPath } from "./coreml";

const COREML_BINARY_NAME = "parakeet-coreml-darwin-arm64";
const GITHUB_REPO = "drakulavich/parakeet-cli";

export type CoreMLInstallState = "missing" | "binary-only" | "ready" | "stale-binary";

export function getCoreMLSupportDir(): string {
  return join(homedir(), ".cache", "parakeet", "coreml");
}

export function getCoreMLDownloadURL(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${COREML_BINARY_NAME}`;
}

export function getCoreMLLatestDownloadURL(): string {
  return `https://github.com/${GITHUB_REPO}/releases/latest/download/${COREML_BINARY_NAME}`;
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

export function isLegacyCoreMLFlagError(detail: string, flag: string): boolean {
  return detail.includes(`file not found: ${flag}`);
}

export function classifyCoreMLInstallCheck(exitCode: number, stderr: string): CoreMLInstallState {
  if (exitCode === 0) {
    return "ready";
  }

  if (isLegacyCoreMLFlagError(stderr, "--check-install")) {
    return "stale-binary";
  }

  return "binary-only";
}

async function fetchCoreMLBinary(): Promise<Response> {
  const latestUrl = getCoreMLLatestDownloadURL();
  let res = await fetch(latestUrl, { redirect: "follow" });

  if (res.ok) {
    return res;
  }

  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const versionUrl = getCoreMLDownloadURL(pkg.version);
  res = await fetch(versionUrl, { redirect: "follow" });

  if (!res.ok) {
    throw new Error(`Failed to download CoreML binary (HTTP ${res.status}). No release found with ${COREML_BINARY_NAME}.`);
  }

  return res;
}

function getCoreMLInstallStatus(binPath: string): CoreMLInstallState {
  const checkProc = Bun.spawnSync([binPath, "--check-install"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  return classifyCoreMLInstallCheck(checkProc.exitCode, checkProc.stderr.toString());
}

async function ensureCoreMLModels(binPath: string): Promise<void> {
  const downloadProc = Bun.spawnSync([binPath, "--download-only"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = downloadProc.stdout.toString();
  const stderr = downloadProc.stderr.toString();

  if (stderr) {
    process.stderr.write(stderr);
  }
  if (stdout) {
    process.stdout.write(stdout);
  }

  if (downloadProc.exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(detail ? `Failed to download CoreML models: ${detail}` : "Failed to download CoreML models");
  }
}

export async function downloadCoreML(noCache = false): Promise<string> {
  const binPath = getCoreMLBinPath();
  const state = getCoreMLInstallState({
    binPath,
    verifyReady: noCache ? undefined : getCoreMLInstallStatus,
  });
  const plan = planCoreMLInstall(state, noCache);

  if (!plan.downloadBinary && !plan.downloadModels) {
    console.log("CoreML backend already installed.");
    return binPath;
  }

  if (plan.downloadBinary) {
    console.error("Downloading parakeet-coreml binary...");
    const res = await fetchCoreMLBinary();
    mkdirSync(dirname(binPath), { recursive: true });
    await Bun.write(binPath, res);
    chmodSync(binPath, 0o755);
  }

  if (plan.downloadModels) {
    await ensureCoreMLModels(binPath);
  }

  console.log("CoreML backend installed successfully.");
  return binPath;
}
