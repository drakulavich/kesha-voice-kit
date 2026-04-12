import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { log } from "./log";
import { streamResponseToFile } from "./progress";

export const LANG_ID_HF_REPO = "drakulavich/parakeet-lang-id-ecapa";

export const LANG_ID_ONNX_FILES = ["lang-id-ecapa.onnx", "labels.json"];

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

export async function downloadLangIdOnnx(noCache = false, modelDir?: string): Promise<string> {
  const dir = modelDir ?? getLangIdOnnxDir();

  if (!noCache && isLangIdOnnxCached(dir)) {
    log.success("Lang-ID ONNX model already downloaded.");
    return dir;
  }

  mkdirSync(dir, { recursive: true });

  for (const file of LANG_ID_ONNX_FILES) {
    const url = `https://huggingface.co/${LANG_ID_HF_REPO}/resolve/main/${file}`;
    const dest = join(dir, file);

    if (!noCache && existsSync(dest)) continue;

    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow" });
    } catch (e) {
      throw new Error(
        `Failed to fetch ${file}: ${e instanceof Error ? e.message : e}\n  Fix: Check your network connection and try again`,
      );
    }

    if (!res.ok) {
      throw new Error(
        `Failed to download ${file}: HTTP ${res.status}\n  Fix: Check your network connection or try again with --no-cache`,
      );
    }

    const bytes = await streamResponseToFile(res, dest, file);

    if (bytes === 0) {
      throw new Error(
        `Downloaded 0 bytes for ${file}\n  Fix: Try again — the server may be temporarily unavailable`,
      );
    }
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

  // Download labels.json directly
  const labelsFile = "labels.json";
  const labelsDest = join(dir, labelsFile);

  if (noCache || !existsSync(labelsDest)) {
    const labelsUrl = `https://huggingface.co/${LANG_ID_HF_REPO}/resolve/main/${labelsFile}`;

    let labelsRes: Response;
    try {
      labelsRes = await fetch(labelsUrl, { redirect: "follow" });
    } catch (e) {
      throw new Error(
        `Failed to fetch ${labelsFile}: ${e instanceof Error ? e.message : e}\n  Fix: Check your network connection and try again`,
      );
    }

    if (!labelsRes.ok) {
      throw new Error(
        `Failed to download ${labelsFile}: HTTP ${labelsRes.status}\n  Fix: Check your network connection or try again with --no-cache`,
      );
    }

    const labelsBytes = await streamResponseToFile(labelsRes, labelsDest, labelsFile);

    if (labelsBytes === 0) {
      throw new Error(
        `Downloaded 0 bytes for ${labelsFile}\n  Fix: Try again — the server may be temporarily unavailable`,
      );
    }
  }

  // Download mlpackage as tar.gz and extract
  const archiveName = "lang-id-ecapa.mlpackage.tar.gz";
  const archiveDest = join(dir, archiveName);
  const archiveUrl = `https://huggingface.co/${LANG_ID_HF_REPO}/resolve/main/${archiveName}`;

  if (noCache || !existsSync(join(dir, "lang-id-ecapa.mlpackage"))) {
    let archiveRes: Response;
    try {
      archiveRes = await fetch(archiveUrl, { redirect: "follow" });
    } catch (e) {
      throw new Error(
        `Failed to fetch ${archiveName}: ${e instanceof Error ? e.message : e}\n  Fix: Check your network connection and try again`,
      );
    }

    if (!archiveRes.ok) {
      throw new Error(
        `Failed to download ${archiveName}: HTTP ${archiveRes.status}\n  Fix: Check your network connection or try again with --no-cache`,
      );
    }

    const archiveBytes = await streamResponseToFile(archiveRes, archiveDest, archiveName);

    if (archiveBytes === 0) {
      throw new Error(
        `Downloaded 0 bytes for ${archiveName}\n  Fix: Try again — the server may be temporarily unavailable`,
      );
    }

    const extract = Bun.spawnSync(["tar", "xzf", archiveDest, "-C", dir], {
      stdout: "pipe",
      stderr: "pipe",
    });

    if (extract.exitCode !== 0) {
      throw new Error(
        `Failed to extract ${archiveName}: ${extract.stderr.toString().trim()}\n  Fix: The downloaded archive may be corrupted — try again with --no-cache`,
      );
    }

    // Clean up the archive after extraction
    const fs = await import("fs");
    fs.rmSync(archiveDest, { force: true });
  }

  log.success("Lang-ID CoreML model downloaded successfully.");
  return dir;
}
