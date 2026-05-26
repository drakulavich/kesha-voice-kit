import { getEngineBinPath } from "../engine";

export interface VoiceInfo {
  voiceId: string;
  modelId: "kokoro" | "vosk" | "avspeech" | "unknown";
  modelName: string;
  languageCode: string;
  languageName: string;
  gender: "male" | "female" | null;
}

export interface LanguageInfo {
  languageCode: string;
  languageName: string;
  voiceCount: number;
}

const langNames = new Intl.DisplayNames(["en"], { type: "language" });

function langNameFor(code: string): string {
  if (!code) return "Unknown";
  try {
    const name = langNames.of(code);
    if (!name || name === code) return code;
    return name;
  } catch {
    return code;
  }
}

function parseVoiceInfo(id: string): VoiceInfo {
  if (id.startsWith("ru-vosk-")) {
    const suffix = id.slice("ru-vosk-".length); // e.g. "m02" or "f01"
    const genderChar = suffix[0];
    const gender: "male" | "female" | null =
      genderChar === "m" ? "male" : genderChar === "f" ? "female" : null;
    return {
      voiceId: id,
      modelId: "vosk",
      modelName: "Vosk-TTS",
      languageCode: "ru",
      languageName: langNameFor("ru"),
      gender,
    };
  }

  if (id.startsWith("en-")) {
    const suffix = id.slice("en-".length); // e.g. "am_michael" or "bf_emma"
    const accent = suffix[0]; // 'a' = American, 'b' = British
    const genderChar = suffix[1]; // 'f' = female, 'm' = male
    const languageCode = accent === "a" ? "en-US" : accent === "b" ? "en-GB" : "en";
    const gender: "male" | "female" | null =
      genderChar === "f" ? "female" : genderChar === "m" ? "male" : null;
    return {
      voiceId: id,
      modelId: "kokoro",
      modelName: "Kokoro-82M",
      languageCode,
      languageName: langNameFor(languageCode),
      gender,
    };
  }

  if (id.startsWith("macos-")) {
    const m = id.match(/[a-z]{2}-[A-Z]{2}/);
    const languageCode = m ? m[0] : "";
    return {
      voiceId: id,
      modelId: "avspeech",
      modelName: "macOS AVSpeech",
      languageCode,
      languageName: langNameFor(languageCode),
      gender: null,
    };
  }

  return {
    voiceId: id,
    modelId: "unknown",
    modelName: "Unknown",
    languageCode: "",
    languageName: "Unknown",
    gender: null,
  };
}

export function parseVoiceLines(text: string): VoiceInfo[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((id) => parseVoiceInfo(id));
}

export async function listVoices(): Promise<VoiceInfo[]> {
  const proc = Bun.spawn([getEngineBinPath(), "say", "--list-voices"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`engine list-voices failed (exit ${code}): ${err.trim()}`);
  }
  return parseVoiceLines(out);
}

export function aggregateLanguages(voices: VoiceInfo[]): LanguageInfo[] {
  const map = new Map<string, LanguageInfo>();
  for (const v of voices) {
    const existing = map.get(v.languageCode);
    if (existing) existing.voiceCount++;
    else map.set(v.languageCode, { languageCode: v.languageCode, languageName: v.languageName, voiceCount: 1 });
  }
  return [...map.values()].sort((a, b) => a.languageCode.localeCompare(b.languageCode));
}
