import { describe, test, expect } from "bun:test";
import { aggregateLanguages, parseVoiceInfo, type VoiceInfo } from "../../src/mcp/voices";

describe("parseVoiceInfo", () => {
  test("maps en-am_michael to American Kokoro, male", () => {
    expect(parseVoiceInfo("en-am_michael")).toEqual({
      voiceId: "en-am_michael",
      modelId: "kokoro",
      modelName: "Kokoro-82M",
      languageCode: "en-US",
      languageName: "American English",
      gender: "male",
    });
  });

  test("maps en-bf_emma to British Kokoro, female", () => {
    expect(parseVoiceInfo("en-bf_emma")).toEqual({
      voiceId: "en-bf_emma",
      modelId: "kokoro",
      modelName: "Kokoro-82M",
      languageCode: "en-GB",
      languageName: "British English",
      gender: "female",
    });
  });

  test("maps ru-vosk-m02 to Vosk-TTS, male", () => {
    expect(parseVoiceInfo("ru-vosk-m02")).toEqual({
      voiceId: "ru-vosk-m02",
      modelId: "vosk",
      modelName: "Vosk-TTS",
      languageCode: "ru",
      languageName: "Russian",
      gender: "male",
    });
  });

  test("maps ru-vosk-f01 to Vosk-TTS, female", () => {
    expect(parseVoiceInfo("ru-vosk-f01")).toEqual({
      voiceId: "ru-vosk-f01",
      modelId: "vosk",
      modelName: "Vosk-TTS",
      languageCode: "ru",
      languageName: "Russian",
      gender: "female",
    });
  });

  test("maps a macos- id to AVSpeech with the embedded locale", () => {
    expect(parseVoiceInfo("macos-com.apple.eloquence.de-DE.Eddy")).toEqual({
      voiceId: "macos-com.apple.eloquence.de-DE.Eddy",
      modelId: "avspeech",
      modelName: "macOS AVSpeech",
      languageCode: "de-DE",
      languageName: "German (Germany)",
      gender: null,
    });
  });

  test("malformed en- id falls through to unknown", () => {
    const v = parseVoiceInfo("en-zzz");
    expect(v.modelId).toBe("unknown");
    expect(v.modelName).toBe("Unknown");
    expect(v.gender).toBeNull();
    expect(v.languageCode).toBe("");
  });

  test("maps es-em_alex to Spanish Kokoro, male", () => {
    expect(parseVoiceInfo("es-em_alex")).toEqual({
      voiceId: "es-em_alex",
      modelId: "kokoro",
      modelName: "Kokoro-82M",
      languageCode: "es",
      languageName: "Spanish",
      gender: "male",
    });
  });

  test("maps ja-jm_kumo to Japanese Kokoro, male", () => {
    expect(parseVoiceInfo("ja-jm_kumo")).toEqual({
      voiceId: "ja-jm_kumo",
      modelId: "kokoro",
      modelName: "Kokoro-82M",
      languageCode: "ja",
      languageName: "Japanese",
      gender: "male",
    });
  });

  test("maps fr-ff_siwis to French Kokoro, female", () => {
    expect(parseVoiceInfo("fr-ff_siwis")).toEqual({
      voiceId: "fr-ff_siwis",
      modelId: "kokoro",
      modelName: "Kokoro-82M",
      languageCode: "fr",
      languageName: "French",
      gender: "female",
    });
  });
});

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
