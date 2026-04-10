import { describe, test, expect } from "bun:test";
import { renderUsage } from "citty";
import { mainCommand, installCommand, statusCommand, formatTextOutput, formatJsonOutput, detectLanguage, checkLanguageMismatch, resolveInstallBackend } from "../../src/cli";

describe("CLI help", () => {
  test("main help contains usage and install info", async () => {
    const usage = await renderUsage(mainCommand);
    expect(usage).toContain("USAGE");
    expect(usage).toContain("install");
  });

  test("install help contains backend options", async () => {
    const usage = await renderUsage(installCommand);
    expect(usage).toContain("--coreml");
    expect(usage).toContain("--onnx");
    expect(usage).toContain("--no-cache");
  });

  test("main help contains --json flag", async () => {
    const usage = await renderUsage(mainCommand);
    expect(usage).toContain("--json");
  });

  test("main help contains --lang flag", async () => {
    const usage = await renderUsage(mainCommand);
    expect(usage).toContain("--lang");
  });

  test("status help has command description", async () => {
    const usage = await renderUsage(statusCommand);
    expect(usage).toContain("status");
    expect(usage).toContain("Show backend installation status");
  });
});

describe("output formatting", () => {
  test("single file text: no header", () => {
    const output = formatTextOutput([{ file: "a.ogg", text: "Hello", lang: "en" }]);
    expect(output).toBe("Hello\n");
  });

  test("multiple files text: headers per file", () => {
    const output = formatTextOutput([
      { file: "a.ogg", text: "Hello", lang: "en" },
      { file: "b.mp3", text: "World", lang: "en" },
    ]);
    expect(output).toBe("=== a.ogg ===\nHello\n\n=== b.mp3 ===\nWorld\n");
  });

  test("JSON output: always array, pretty-printed", () => {
    const output = formatJsonOutput([{ file: "a.ogg", text: "Hello", lang: "en" }]);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([{ file: "a.ogg", text: "Hello", lang: "en" }]);
    expect(output).toContain("\n");
  });

  test("JSON output: multiple files", () => {
    const output = formatJsonOutput([
      { file: "a.ogg", text: "Hello", lang: "en" },
      { file: "b.mp3", text: "World", lang: "en" },
    ]);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].file).toBe("a.ogg");
    expect(parsed[1].file).toBe("b.mp3");
  });

  test("JSON output: empty array when no results", () => {
    const output = formatJsonOutput([]);
    expect(JSON.parse(output)).toEqual([]);
  });
});

describe("output formatting with lang", () => {
  test("JSON output includes lang field", () => {
    const output = formatJsonOutput([{ file: "a.ogg", text: "Hello world", lang: "en" }]);
    const parsed = JSON.parse(output);
    expect(parsed[0].lang).toBe("en");
  });

  test("JSON output includes empty lang when not detected", () => {
    const output = formatJsonOutput([{ file: "a.ogg", text: "", lang: "" }]);
    const parsed = JSON.parse(output);
    expect(parsed[0].lang).toBe("");
  });
});

describe("language detection", () => {
  test("detects English text", () => {
    const lang = detectLanguage("This is a simple English sentence for testing.");
    expect(lang).toBe("en");
  });

  test("detects Russian text", () => {
    const lang = detectLanguage("Это простое предложение на русском языке для тестирования.");
    expect(lang).toBe("ru");
  });

  test("returns empty string for empty text", () => {
    const lang = detectLanguage("");
    expect(lang).toBe("");
  });

  test("checkLanguageMismatch returns null when no expected lang", () => {
    const warning = checkLanguageMismatch(undefined, "en");
    expect(warning).toBeNull();
  });

  test("checkLanguageMismatch returns null when languages match", () => {
    const warning = checkLanguageMismatch("en", "en");
    expect(warning).toBeNull();
  });

  test("checkLanguageMismatch returns warning when languages differ", () => {
    const warning = checkLanguageMismatch("ru", "en");
    expect(warning).toContain("expected language");
    expect(warning).toContain("ru");
    expect(warning).toContain("en");
  });

  test("checkLanguageMismatch returns null when detected is empty", () => {
    const warning = checkLanguageMismatch("en", "");
    expect(warning).toBeNull();
  });
});

describe("install backend selection", () => {
  test("rejects conflicting backend flags", () => {
    expect(() =>
      resolveInstallBackend({ coreml: true, onnx: true, noCache: false }, true),
    ).toThrow('Choose only one backend');
  });

  test("defaults to CoreML on macOS Apple Silicon", () => {
    expect(resolveInstallBackend({ coreml: false, onnx: false, noCache: false }, true)).toBe("coreml");
  });

  test("defaults to ONNX on non-macOS", () => {
    expect(resolveInstallBackend({ coreml: false, onnx: false, noCache: false }, false)).toBe("onnx");
  });
});

describe("CLI help with status", () => {
  test("main description mentions install command", async () => {
    const usage = await renderUsage(mainCommand);
    expect(usage).toContain("install");
  });

  test("main help includes status command", async () => {
    const usage = await renderUsage(mainCommand);
    expect(usage).toContain("status");
  });
});
