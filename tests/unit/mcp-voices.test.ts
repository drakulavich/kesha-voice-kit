import { describe, test, expect } from "bun:test";
import { parseVoiceLines, aggregateLanguages } from "../../src/mcp/voices";

describe("parseVoiceLines", () => {
  test("maps ids to new VoiceInfo shape", () => {
    const out = parseVoiceLines(
      "en-am_michael\nen-bf_emma\nru-vosk-m02\nmacos-com.apple.eloquence.de-DE.Eddy\n",
    );
    expect(out).toEqual([
      {
        voiceId: "en-am_michael",
        modelId: "kokoro",
        modelName: "Kokoro-82M",
        languageCode: "en-US",
        languageName: "American English",
        gender: "male",
      },
      {
        voiceId: "en-bf_emma",
        modelId: "kokoro",
        modelName: "Kokoro-82M",
        languageCode: "en-GB",
        languageName: "British English",
        gender: "female",
      },
      {
        voiceId: "ru-vosk-m02",
        modelId: "vosk",
        modelName: "Vosk-TTS",
        languageCode: "ru",
        languageName: "Russian",
        gender: "male",
      },
      {
        voiceId: "macos-com.apple.eloquence.de-DE.Eddy",
        modelId: "avspeech",
        modelName: "macOS AVSpeech",
        languageCode: "de-DE",
        languageName: "German (Germany)",
        gender: null,
      },
    ]);
  });

  test("ignores blank lines and trims", () => {
    const out = parseVoiceLines("  en-am_adam  \n\n");
    expect(out).toEqual([
      {
        voiceId: "en-am_adam",
        modelId: "kokoro",
        modelName: "Kokoro-82M",
        languageCode: "en-US",
        languageName: "American English",
        gender: "male",
      },
    ]);
  });

  test("malformed en- id falls through to unknown", () => {
    const [v] = parseVoiceLines("en-zzz");
    expect(v.modelId).toBe("unknown");
    expect(v.modelName).toBe("Unknown");
    expect(v.gender).toBeNull();
    expect(v.languageCode).toBe("");
  });

  test("vosk female voice has gender female", () => {
    const [v] = parseVoiceLines("ru-vosk-f01");
    expect(v.gender).toBe("female");
    expect(v.languageCode).toBe("ru");
  });

  test("macos voice has gender null", () => {
    const [v] = parseVoiceLines("macos-com.apple.voice.compact.ru-RU.Milena");
    expect(v.gender).toBeNull();
    expect(v.modelId).toBe("avspeech");
    expect(v.languageCode).toBe("ru-RU");
  });
});

describe("aggregateLanguages", () => {
  test("counts voices per language and sorts by code", () => {
    const voices = parseVoiceLines("en-am_michael\nen-am_adam\nru-vosk-m02");
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
