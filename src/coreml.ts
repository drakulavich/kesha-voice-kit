import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { unlinkSync } from "fs";
import { convertToWav16kMono } from "./audio";
import type { LangDetectResult } from "./lang-id";

export function isMacArm64(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

export function getCoreMLBinPath(): string {
  return join(homedir(), ".cache", "parakeet", "coreml", "bin", "parakeet-coreml");
}

export function isCoreMLInstalled(): boolean {
  return isMacArm64() && existsSync(getCoreMLBinPath());
}

export async function transcribeCoreML(audioPath: string): Promise<string> {
  try {
    return await runCoreML(audioPath);
  } catch (error) {
    if (!shouldRetryCoreMLWithWav(audioPath, error)) {
      throw error;
    }

    const wavPath = await convertToWav16kMono(audioPath);
    try {
      return await runCoreML(wavPath);
    } finally {
      try { unlinkSync(wavPath); } catch {}
    }
  }
}

export function shouldRetryCoreMLWithWav(audioPath: string, error: unknown): boolean {
  if (audioPath.toLowerCase().endsWith(".wav")) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("com.apple.coreaudio.avfaudio error");
}

export function parseCoreMLLangResult(stdout: string): LangDetectResult | null {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.code !== "string" || typeof parsed.confidence !== "number") {
      return null;
    }
    return { code: parsed.code, confidence: parsed.confidence };
  } catch {
    return null;
  }
}

export async function detectAudioLanguageCoreML(audioPath: string): Promise<LangDetectResult | null> {
  if (!isCoreMLInstalled()) return null;
  const binPath = getCoreMLBinPath();
  const proc = Bun.spawn([binPath, "detect-lang", audioPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return null;
  return parseCoreMLLangResult(stdout.trim());
}

export async function detectTextLanguageCoreML(text: string): Promise<LangDetectResult | null> {
  if (!isCoreMLInstalled()) return null;
  const binPath = getCoreMLBinPath();
  const proc = Bun.spawn([binPath, "detect-text-lang", text], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return null;
  return parseCoreMLLangResult(stdout.trim());
}

async function runCoreML(audioPath: string): Promise<string> {
  const binPath = getCoreMLBinPath();
  const proc = Bun.spawn([binPath, audioPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `parakeet-coreml exited with code ${exitCode}`);
  }

  return stdout.trim();
}
