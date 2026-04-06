import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

export type ModelVersion = "v2" | "v3";

export const HF_REPOS: Record<ModelVersion, string> = {
  v2: "istupakov/parakeet-tdt-0.6b-v2-onnx",
  v3: "istupakov/parakeet-tdt-0.6b-v3-onnx",
};

export const MODEL_FILES = [
  "encoder-model.onnx",
  "encoder-model.onnx.data",
  "decoder_joint-model.onnx",
  "nemo128.onnx",
  "vocab.txt",
];

export function getModelDir(version: ModelVersion): string {
  return join(homedir(), ".cache", "parakeet", version);
}

export function isModelCached(version: ModelVersion): boolean {
  const dir = getModelDir(version);
  return MODEL_FILES.every((f) => existsSync(join(dir, f)));
}

export async function ensureModel(version: ModelVersion, noCache = false): Promise<string> {
  const dir = getModelDir(version);

  if (!noCache && isModelCached(version)) {
    return dir;
  }

  mkdirSync(dir, { recursive: true });

  const repo = HF_REPOS[version];

  for (const file of MODEL_FILES) {
    const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
    const dest = join(dir, file);

    if (!noCache && existsSync(dest)) continue;

    console.error(`Downloading ${file}...`);

    const res = await fetch(url, { redirect: "follow" });

    if (!res.ok) {
      throw new Error(`failed to download model: ${url} (${res.status})`);
    }

    await Bun.write(dest, res);
  }

  return dir;
}
