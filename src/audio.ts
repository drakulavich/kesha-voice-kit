import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

let ffmpegChecked = false;

export async function convertToFloat32PCM(inputPath: string): Promise<Float32Array> {
  const tmpPath = await convertAudioWithFfmpeg(inputPath, "f32le", [
    "-ar", "16000",
    "-ac", "1",
    "-f", "f32le",
    "-acodec", "pcm_f32le",
  ]);

  try {
    const raw = await Bun.file(tmpPath).arrayBuffer();
    return new Float32Array(raw);
  } finally {
    // Best-effort cleanup; file may already be gone
    try { unlinkSync(tmpPath); } catch {}
  }
}

export async function convertToWav16kMono(inputPath: string): Promise<string> {
  return convertAudioWithFfmpeg(inputPath, "wav", [
    "-ar", "16000",
    "-ac", "1",
    "-f", "wav",
    "-acodec", "pcm_s16le",
  ]);
}

async function convertAudioWithFfmpeg(
  inputPath: string,
  extension: string,
  ffmpegArgs: string[],
): Promise<string> {
  if (!existsSync(inputPath)) {
    throw new Error(`file not found: ${inputPath}`);
  }

  assertFfmpegExists();

  const tmpPath = join(tmpdir(), `parakeet-${randomUUID()}.${extension}`);

  const proc = Bun.spawn(
    ["ffmpeg", "-i", inputPath, ...ffmpegArgs, tmpPath, "-y"],
    { stdout: "pipe", stderr: "pipe" }
  );

  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    const lastLine = stderr.trim().split("\n").pop() ?? "unknown error";
    throw new Error(
      `Audio conversion failed: ${lastLine}\n  File: ${inputPath}\n  Fix: Ensure the file is a valid audio format. Run "ffmpeg -i ${inputPath}" to diagnose.`,
    );
  }

  return tmpPath;
}

export function getFfmpegInstallHint(): string {
  const platform = process.platform;

  if (platform === "darwin") {
    if (Bun.which("brew")) return "  brew install ffmpeg";
    if (Bun.which("port")) return "  sudo port install ffmpeg";
  }

  if (platform === "linux") {
    if (Bun.which("apt")) return "  sudo apt install ffmpeg";
    if (Bun.which("dnf")) return "  sudo dnf install ffmpeg-free";
    if (Bun.which("pacman")) return "  sudo pacman -S ffmpeg";
  }

  if (platform === "win32") {
    if (Bun.which("choco")) return "  choco install ffmpeg";
    if (Bun.which("scoop")) return "  scoop install ffmpeg";
    if (Bun.which("winget")) return "  winget install ffmpeg";
  }

  return "  https://ffmpeg.org/download.html";
}

export function assertFfmpegExists(): void {
  if (ffmpegChecked) return;
  if (!Bun.which("ffmpeg")) {
    const hint = getFfmpegInstallHint();
    throw new Error(
      `ffmpeg is required but not found in PATH.\n\nInstall it:\n${hint}`
    );
  }
  ffmpegChecked = true;
}

export function resetFfmpegCheck(): void {
  ffmpegChecked = false;
}
