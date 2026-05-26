import { getEngineBinPath } from "../engine";

export interface VoiceInfo {
  id: string;
  engine: "kokoro" | "vosk" | "avspeech" | "unknown";
  lang: string | null;
}

function engineFor(id: string): VoiceInfo["engine"] {
  if (id.startsWith("ru-vosk-")) return "vosk";
  if (id.startsWith("en-")) return "kokoro";
  if (id.startsWith("macos-")) return "avspeech";
  return "unknown";
}

function langFor(id: string): string | null {
  if (id.startsWith("en-")) return "en";
  if (id.startsWith("ru-vosk-")) return "ru";
  const m = id.match(/[a-z]{2}-[A-Z]{2}/);
  return m ? m[0] : null;
}

export function parseVoiceLines(text: string): VoiceInfo[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((id) => ({ id, engine: engineFor(id), lang: langFor(id) }));
}

export async function listVoices(): Promise<VoiceInfo[]> {
  const proc = Bun.spawn([getEngineBinPath(), "say", "--list-voices"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`engine list-voices failed (exit ${code}): ${err.trim()}`);
  }
  return parseVoiceLines(out);
}
