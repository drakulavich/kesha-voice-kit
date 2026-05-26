import { describe, test, expect } from "bun:test";
import { parseVoiceLines } from "../../src/mcp/voices";

describe("parseVoiceLines", () => {
  test("maps ids to engine + lang", () => {
    const out = parseVoiceLines(
      "en-am_michael\nru-vosk-m02\nmacos-com.apple.eloquence.de-DE.Eddy\n\n",
    );
    expect(out).toEqual([
      { id: "en-am_michael", engine: "kokoro", lang: "en" },
      { id: "ru-vosk-m02", engine: "vosk", lang: "ru" },
      { id: "macos-com.apple.eloquence.de-DE.Eddy", engine: "avspeech", lang: "de-DE" },
    ]);
  });

  test("ignores blank lines and trims", () => {
    expect(parseVoiceLines("  en-am_adam  \n\n")).toEqual([
      { id: "en-am_adam", engine: "kokoro", lang: "en" },
    ]);
  });
});
