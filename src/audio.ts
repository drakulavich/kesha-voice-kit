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

  await assertFfmpegExists();

  const tmpPath = join(tmpdir(), `parakeet-${randomUUID()}.${extension}`);

  const proc = Bun.spawn(
    ["ffmpeg", "-i", inputPath, ...ffmpegArgs, tmpPath, "-y"],
    { stdout: "pipe", stderr: "pipe" }
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`failed to convert audio: ${stderr.trim().split("\n").pop()}`);
  }

  return tmpPath;
}

async function assertFfmpegExists(): Promise<void> {
  if (ffmpegChecked) return;
  const proc = Bun.spawn(["which", "ffmpeg"], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("ffmpeg not found in PATH");
  }
  ffmpegChecked = true;
}
