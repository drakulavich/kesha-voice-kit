import { describe, test, expect } from "bun:test";
import { aggregateLanguages, type VoiceInfo } from "../../src/mcp/voices";

describe("aggregateLanguages", () => {
  test("counts voices per language and sorts by code", () => {
    const voices: VoiceInfo[] = [
      { voiceId: "en-am_michael", modelId: "kokoro", modelName: "Kokoro-82M", languageCode: "en-US", languageName: "American English", gender: "male" },
      { voiceId: "en-am_adam", modelId: "kokoro", modelName: "Kokoro-82M", languageCode: "en-US", languageName: "American English", gender: "male" },
      { voiceId: "ru-vosk-m02", modelId: "vosk", modelName: "Vosk-TTS", languageCode: "ru", languageName: "Russian", gender: "male" },
    ];
    const langs = aggregateLanguages(voices);
    expect(langs).toEqual([
      { languageCode: "en-US", languageName: "American English", voiceCount: 2 },
      { languageCode: "ru", languageName: "Russian", voiceCount: 1 },
    ]);
  });

  test("returns empty array for no voices", () => {
    expect(aggregateLanguages([])).toEqual([]);
  });
});
