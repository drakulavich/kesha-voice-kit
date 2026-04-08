import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { unlinkSync } from "fs";
import { convertToWav16kMono } from "./audio";

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
  return message.includes("com.apple.coreaudio.avfaudio error")
    || message.includes("The operation couldn’t be completed. (com.apple.coreaudio.avfaudio error");
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
    throw new Error(stderr);
  }

  return stdout.trim();
}
