import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, chmodSync } from "fs";
import { isCoreMLInstalled } from "./coreml";

export const HF_REPO = "istupakov/parakeet-tdt-0.6b-v3-onnx";

export const MODEL_FILES = [
  "encoder-model.onnx",
  "encoder-model.onnx.data",
  "decoder_joint-model.onnx",
  "nemo128.onnx",
  "vocab.txt",
];

export function getModelDir(): string {
  return join(homedir(), ".cache", "parakeet", "v3");
}

export function isModelCached(dir?: string): boolean {
  const d = dir ?? getModelDir();
  return MODEL_FILES.every((f) => existsSync(join(d, f)));
}

export function isModelInstalled(modelDir?: string): boolean {
  return isCoreMLInstalled() || isModelCached(modelDir);
}

export function installHintError(headline: string): Error {
  const lines = [
    headline,
    "",
    "╔══════════════════════════════════════════════════════════╗",
    "║ Please run the following command to get started:         ║",
    "║                                                          ║",
    "║     bunx @drakulavich/parakeet-cli install               ║",
    "╚══════════════════════════════════════════════════════════╝",
  ];
  return new Error(lines.join("\n"));
}

export function requireModel(modelDir?: string): string {
  const dir = modelDir ?? getModelDir();

  if (!isModelCached(dir)) {
    throw installHintError(`Error: Model not found at ${dir}`);
  }

  return dir;
}

export async function downloadModel(noCache = false, modelDir?: string): Promise<string> {
  const dir = modelDir ?? getModelDir();

  if (!noCache && isModelCached(dir)) {
    console.log("Model already downloaded.");
    return dir;
  }

  mkdirSync(dir, { recursive: true });

  for (const file of MODEL_FILES) {
    const url = `https://huggingface.co/${HF_REPO}/resolve/main/${file}`;
    const dest = join(dir, file);

    if (!noCache && existsSync(dest)) continue;

    console.error(`Downloading ${file}...`);

    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow" });
    } catch (e) {
      throw new Error(`failed to fetch ${file}: ${e instanceof Error ? e.message : e}`);
    }

    if (!res.ok) {
      throw new Error(`failed to download ${file}: HTTP ${res.status}`);
    }

    if (!res.body) {
      throw new Error(`empty response body for ${file}`);
    }

    const writer = Bun.file(dest).writer();
    let bytes = 0;
    try {
      for await (const chunk of res.body) {
        writer.write(chunk);
        bytes += chunk.length;
      }
    } finally {
      writer.end();
    }

    if (bytes === 0) {
      throw new Error(`downloaded 0 bytes for ${file}`);
    }
  }

  console.log("Model downloaded successfully.");
  return dir;
}

const COREML_BINARY_NAME = "parakeet-coreml-darwin-arm64";
const GITHUB_REPO = "drakulavich/parakeet-cli";

export function getCoreMLDownloadURL(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${COREML_BINARY_NAME}`;
}

export function getCoreMLLatestDownloadURL(): string {
  return `https://github.com/${GITHUB_REPO}/releases/latest/download/${COREML_BINARY_NAME}`;
}

export async function downloadCoreML(noCache = false): Promise<string> {
  const { getCoreMLBinPath } = await import("./coreml");
  const binPath = getCoreMLBinPath();

  if (!noCache && existsSync(binPath)) {
    // Binary exists — ensure models are also downloaded
    const checkProc = Bun.spawnSync([binPath, "--download-only"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (checkProc.exitCode === 0) {
      console.log("CoreML backend already installed.");
      return binPath;
    }
    // Models missing — continue to re-download
  }

  // Try latest release first, fall back to version-specific
  const latestUrl = getCoreMLLatestDownloadURL();
  console.error("Downloading parakeet-coreml binary...");

  let res = await fetch(latestUrl, { redirect: "follow" });

  if (!res.ok) {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const versionUrl = getCoreMLDownloadURL(pkg.version);
    res = await fetch(versionUrl, { redirect: "follow" });
  }

  if (!res.ok) {
    throw new Error(`Failed to download CoreML binary (HTTP ${res.status}). No release found with ${COREML_BINARY_NAME}.`);
  }

  mkdirSync(dirname(binPath), { recursive: true });

  await Bun.write(binPath, res);

  chmodSync(binPath, 0o755);

  // Download CoreML model files (first transcription would be slow without this)
  console.error("Downloading CoreML models...");
  const downloadProc = Bun.spawnSync([binPath, "--download-only"], {
    stdout: "inherit",
    stderr: "inherit",
  });

  if (downloadProc.exitCode !== 0) {
    throw new Error("Failed to download CoreML models");
  }

  console.log("CoreML backend installed successfully.");
  return binPath;
}
