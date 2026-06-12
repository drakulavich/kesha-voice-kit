import { describe, expect, test } from "bun:test";
import {
  formatTextOutput,
  formatTranscriptOutput,
  formatVerboseOutput,
  humanBytes,
} from "../../src/format";
import type { TranscribeResult } from "../../src/types";

function result(overrides: Partial<TranscribeResult>): TranscribeResult {
  return { file: "a.ogg", text: "hello", ...overrides } as TranscribeResult;
}

describe("humanBytes", () => {
  test("bytes below 1024 stay in B", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1023)).toBe("1023 B");
  });

  test("scales through KB/MB/GB/TB", () => {
    expect(humanBytes(1024)).toBe("1.0 KB");
    expect(humanBytes(1536)).toBe("1.5 KB");
    expect(humanBytes(1024 * 1024)).toBe("1.0 MB");
    expect(humanBytes(1024 ** 3)).toBe("1.0 GB");
    expect(humanBytes(1024 ** 4)).toBe("1.0 TB");
  });

  test("drops decimals at 100+ of a unit", () => {
    expect(humanBytes(150 * 1024)).toBe("150 KB");
    expect(humanBytes(99.4 * 1024)).toBe("99.4 KB");
  });

  test("caps at TB instead of inventing units", () => {
    expect(humanBytes(1024 ** 5)).toBe("1024 TB");
  });
});

describe("formatTextOutput", () => {
  test("single result is bare text", () => {
    expect(formatTextOutput([result({})])).toBe("hello\n");
  });

  test("multiple results get file headers", () => {
    const out = formatTextOutput([
      result({ file: "a.ogg", text: "one" }),
      result({ file: "b.ogg", text: "two" }),
    ]);
    expect(out).toBe("=== a.ogg ===\none\n\n=== b.ogg ===\ntwo\n");
  });
});

describe("formatTranscriptOutput", () => {
  test("appends lang line with confidence", () => {
    const out = formatTranscriptOutput([
      result({ textLanguage: { code: "ru", confidence: 0.987 } }),
    ]);
    expect(out).toBe("hello\n[lang: ru, confidence: 0.99]\n");
  });

  test("omits lang line when no language fields are present", () => {
    expect(formatTranscriptOutput([result({})])).toBe("hello\n");
  });
});

describe("formatVerboseOutput", () => {
  test("includes language, timing, and separator lines", () => {
    const out = formatVerboseOutput([
      result({
        audioLanguage: { code: "en", confidence: 0.5 },
        textLanguage: { code: "en", confidence: 0.75 },
        sttTimeMs: 120,
      }),
    ]);
    expect(out).toBe(
      "Audio language: en (confidence: 0.50)\n" +
        "Text language: en (confidence: 0.75)\n" +
        "STT time: 120ms\n" +
        "---\n" +
        "hello\n",
    );
  });

  test("falls back to legacy lang field without confidence", () => {
    const out = formatVerboseOutput([result({ lang: "fr" })]);
    expect(out).toBe("Text language: fr\n---\nhello\n");
  });

  test("multiple results get file headers", () => {
    const out = formatVerboseOutput([
      result({ file: "a.ogg", text: "one" }),
      result({ file: "b.ogg", text: "two" }),
    ]);
    expect(out).toBe("=== a.ogg ===\n---\none\n\n=== b.ogg ===\n---\ntwo\n");
  });
});
