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
  const resolvedDir = dir ?? getModelDir();
  return MODEL_FILES.every((file) => existsSync(join(resolvedDir, file)));
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
