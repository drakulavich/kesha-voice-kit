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
    console.error("Model already downloaded.");
    return dir;
  }

  mkdirSync(dir, { recursive: true });

  for (const file of MODEL_FILES) {
    const url = `https://huggingface.co/${HF_REPO}/resolve/main/${file}`;
    const dest = join(dir, file);

    if (!noCache && existsSync(dest)) continue;

    console.error(`Downloading ${file}...`);

    const res = await fetch(url, { redirect: "follow" });

    if (!res.ok) {
      throw new Error(`failed to download model: ${url} (${res.status})`);
    }

    await Bun.write(dest, res);
  }

  console.error("Model downloaded successfully.");
  return dir;
}

export function getCoreMLDownloadURL(version: string): string {
  return `https://github.com/drakulavich/parakeet-cli/releases/download/v${version}/parakeet-coreml-darwin-arm64`;
}

export async function downloadCoreML(noCache = false): Promise<string> {
  const { getCoreMLBinPath } = await import("./coreml");
  const binPath = getCoreMLBinPath();

  if (!noCache && existsSync(binPath)) {
    console.error("CoreML backend already installed.");
    return binPath;
  }

  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const url = getCoreMLDownloadURL(pkg.version);

  console.error("Downloading parakeet-coreml binary...");

  const res = await fetch(url, { redirect: "follow" });

  if (!res.ok) {
    throw new Error(`Failed to download CoreML binary: ${url} (${res.status})`);
  }

  mkdirSync(dirname(binPath), { recursive: true });

  await Bun.write(binPath, res);

  chmodSync(binPath, 0o755);

  console.error("CoreML backend installed successfully.");
  return binPath;
}
