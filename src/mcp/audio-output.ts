import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";
import type { SayFormat } from "../synth";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function audioDir(): string {
  return join(tmpdir(), "kesha-mcp");
}

function extFor(format: SayFormat): string {
  switch (format) {
    case "ogg-opus":
      return "ogg";
    case "flac":
      return "flac";
    case "wav":
    default:
      return "wav";
  }
}

export function allocAudioPath(format: SayFormat): string {
  mkdirSync(audioDir(), { recursive: true, mode: 0o700 });
  return join(audioDir(), `${randomUUID()}.${extFor(format)}`);
}

export function sweepOldAudio(): void {
  const dir = audioDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of entries) {
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    } catch {
      // best-effort: race with another session or perms — ignore
    }
  }
}
