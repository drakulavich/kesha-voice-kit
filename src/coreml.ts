import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

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
  const binPath = getCoreMLBinPath();
  const proc = Bun.spawn([binPath, audioPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(stderr);
  }

  return stdout.trim();
}
