import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

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

export function requireModel(modelDir?: string): string {
  const dir = modelDir ?? getModelDir();

  if (!isModelCached(dir)) {
    const lines = [
      `Error: Model not found at ${dir}`,
      "",
      "╔══════════════════════════════════════════════════════════╗",
      "║ Looks like Parakeet model is not downloaded yet.         ║",
      "║ Please run the following command to download the model:  ║",
      "║                                                          ║",
      "║     npx @drakulavich/parakeet-cli install                ║",
      "╚══════════════════════════════════════════════════════════╝",
    ];
    throw new Error(lines.join("\n"));
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
