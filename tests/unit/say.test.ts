import { describe, it, expect } from "bun:test";
import { buildSayArgs } from "../../src/say";
import { pickVoiceForLang } from "../../src/cli";

describe("buildSayArgs", () => {
  it("starts with the 'say' subcommand", () => {
    expect(buildSayArgs({})[0]).toBe("say");
  });

  it("appends text as a trailing positional", () => {
    expect(buildSayArgs({ text: "Hello" })).toContain("Hello");
  });

  it("omits empty text (caller will pipe via stdin)", () => {
    expect(buildSayArgs({ text: "" })).toEqual(["say"]);
  });

  it("omits undefined text (caller will pipe via stdin)", () => {
    expect(buildSayArgs({})).toEqual(["say"]);
  });

  it("passes --voice when given", () => {
    expect(buildSayArgs({ text: "Hi", voice: "en-af_heart" })).toEqual(
      expect.arrayContaining(["--voice", "en-af_heart"]),
    );
  });

  it("passes --lang when given", () => {
    expect(buildSayArgs({ text: "Hi", lang: "en-gb" })).toEqual(
      expect.arrayContaining(["--lang", "en-gb"]),
    );
  });

  it("passes --out when given", () => {
    expect(buildSayArgs({ text: "Hi", out: "reply.wav" })).toEqual(
      expect.arrayContaining(["--out", "reply.wav"]),
    );
  });

  it("omits --rate when default (1.0)", () => {
    expect(buildSayArgs({ text: "Hi", rate: 1.0 })).not.toContain("--rate");
  });

  it("includes --rate when non-default", () => {
    expect(buildSayArgs({ text: "Hi", rate: 1.25 })).toEqual(
      expect.arrayContaining(["--rate", "1.25"]),
    );
  });

  it("places text positional after flags (not parsed as option arg)", () => {
    const args = buildSayArgs({ text: "Hello", voice: "en-af_heart", lang: "en-us" });
    const textIdx = args.indexOf("Hello");
    const voiceIdx = args.indexOf("--voice");
    const langIdx = args.indexOf("--lang");
    expect(textIdx).toBeGreaterThan(voiceIdx);
    expect(textIdx).toBeGreaterThan(langIdx);
  });
});

describe("pickVoiceForLang (auto-routing)", () => {
  it("returns en-af_heart for English with high confidence", () => {
    expect(pickVoiceForLang("en", 0.95)).toBe("en-af_heart");
  });

  it("returns ru-denis for Russian with high confidence", () => {
    expect(pickVoiceForLang("ru", 0.95)).toBe("ru-denis");
  });

  it("returns undefined below 0.5 confidence (too ambiguous)", () => {
    expect(pickVoiceForLang("ru", 0.3)).toBeUndefined();
  });

  it("returns undefined for unsupported languages", () => {
    expect(pickVoiceForLang("fr", 0.95)).toBeUndefined();
    expect(pickVoiceForLang("de", 0.95)).toBeUndefined();
  });

  it("returns undefined when code is missing", () => {
    expect(pickVoiceForLang(undefined, 0.95)).toBeUndefined();
    expect(pickVoiceForLang("", 0.95)).toBeUndefined();
  });
});
