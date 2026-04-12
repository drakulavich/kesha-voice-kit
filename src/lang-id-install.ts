import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, rmSync } from "fs";
import { log } from "./log";
import { streamResponseToFile } from "./progress";

export const LANG_ID_HF_REPO = "drakulavich/SpeechBrain-coreml";

export const LANG_ID_ONNX_FILES = ["lang-id-ecapa.onnx", "lang-id-ecapa.onnx.data", "labels.json"];

export const LANG_ID_COREML_FILES = ["lang-id-ecapa.mlpackage", "labels.json"];

export function getLangIdOnnxDir(): string {
  return join(homedir(), ".cache", "parakeet", "lang-id", "onnx");
}

export function getLangIdCoreMLDir(): string {
  return join(homedir(), ".cache", "parakeet", "lang-id", "coreml");
}

export function isLangIdOnnxCached(dir?: string): boolean {
  const resolvedDir = dir ?? getLangIdOnnxDir();
  return LANG_ID_ONNX_FILES.every((file) => existsSync(join(resolvedDir, file)));
}

export function isLangIdCoreMLCached(dir?: string): boolean {
  const resolvedDir = dir ?? getLangIdCoreMLDir();
  return LANG_ID_COREML_FILES.every((file) => existsSync(join(resolvedDir, file)));
}

async function downloadSingleFile(url: string, dest: string, displayName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    throw new Error(
      `Failed to fetch ${displayName}: ${e instanceof Error ? e.message : e}\n  Fix: Check your network connection and try again`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Failed to download ${displayName}: HTTP ${res.status}\n  Fix: Check your network connection or try again with --no-cache`,
    );
  }

  const bytes = await streamResponseToFile(res, dest, displayName);

  if (bytes === 0) {
    throw new Error(
      `Downloaded 0 bytes for ${displayName}\n  Fix: Try again — the server may be temporarily unavailable`,
    );
  }
}

export async function downloadLangIdOnnx(noCache = false, modelDir?: string): Promise<string> {
  const dir = modelDir ?? getLangIdOnnxDir();

  if (!noCache && isLangIdOnnxCached(dir)) {
    log.success("Lang-ID ONNX model already downloaded.");
    return dir;
  }

  mkdirSync(dir, { recursive: true });

  for (const file of LANG_ID_ONNX_FILES) {
    const dest = join(dir, file);
    if (!noCache && existsSync(dest)) continue;
    const url = `https://huggingface.co/${LANG_ID_HF_REPO}/resolve/main/${file}`;
    await downloadSingleFile(url, dest, file);
  }

  log.success("Lang-ID ONNX model downloaded successfully.");
  return dir;
}

export async function downloadLangIdCoreML(noCache = false, modelDir?: string): Promise<string> {
  const dir = modelDir ?? getLangIdCoreMLDir();

  if (!noCache && isLangIdCoreMLCached(dir)) {
    log.success("Lang-ID CoreML model already downloaded.");
    return dir;
  }

  mkdirSync(dir, { recursive: true });

  // Download labels.json
  const labelsDest = join(dir, "labels.json");
  if (noCache || !existsSync(labelsDest)) {
    const url = `https://huggingface.co/${LANG_ID_HF_REPO}/resolve/main/labels.json`;
    await downloadSingleFile(url, labelsDest, "labels.json");
  }

  // Download mlpackage as tar.gz and extract
  const archiveName = "lang-id-ecapa.mlpackage.tar.gz";
  const archiveDest = join(dir, archiveName);

  if (noCache || !existsSync(join(dir, "lang-id-ecapa.mlpackage"))) {
    const url = `https://huggingface.co/${LANG_ID_HF_REPO}/resolve/main/${archiveName}`;
    await downloadSingleFile(url, archiveDest, archiveName);

    const extract = Bun.spawnSync(["tar", "xzf", archiveDest, "-C", dir], {
      stdout: "pipe",
      stderr: "pipe",
    });

    if (extract.exitCode !== 0) {
      throw new Error(
        `Failed to extract ${archiveName}: ${extract.stderr.toString().trim()}\n  Fix: The downloaded archive may be corrupted — try again with --no-cache`,
      );
    }

    rmSync(archiveDest, { force: true });
  }

  log.success("Lang-ID CoreML model downloaded successfully.");
  return dir;
}
