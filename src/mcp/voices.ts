import { listVoiceIds } from "../synth";

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

  if (id.startsWith("en-") && /^[ab][fm]_/.test(id.slice(3))) {
    const suffix = id.slice("en-".length); // e.g. "am_michael" or "bf_emma"
    const accent = suffix[0]; // 'a' = American, 'b' = British
    const genderChar = suffix[1]; // 'f' = female, 'm' = male
    const languageCode = accent === "a" ? "en-US" : "en-GB";
    const gender: "male" | "female" = genderChar === "f" ? "female" : "male";
    return {
      voiceId: id,
      modelId: "kokoro",
      modelName: "Kokoro-82M",
      languageCode,
      languageName: langNameFor(languageCode),
      gender,
    };
  }

  const kokoro = id.match(/^(es|fr|hi|it|ja|pt|zh)-([a-z][fm]_.+)$/);
  if (kokoro) {
    const languageCode = kokoro[1] ?? "";
    const bareVoice = kokoro[2] ?? "";
    const genderChar = bareVoice[1];
    const gender: "male" | "female" = genderChar === "f" ? "female" : "male";
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

export async function listVoices(): Promise<VoiceInfo[]> {
  return (await listVoiceIds()).map(parseVoiceInfo);
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
