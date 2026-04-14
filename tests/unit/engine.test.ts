import { describe, test, expect } from "bun:test";
import { parseLangResult, getEngineBinPath } from "../../src/engine";

describe("engine", () => {
  test("getEngineBinPath returns path under .cache/kesha", () => {
    const path = getEngineBinPath();
    expect(path).toContain(".cache/kesha");
    expect(path).toContain("kesha-engine");
  });

  test("parseLangResult parses valid JSON", () => {
    expect(parseLangResult('{"code":"ru","confidence":0.94}')).toEqual({ code: "ru", confidence: 0.94 });
  });

  test("parseLangResult returns null for invalid JSON", () => {
    expect(parseLangResult("not json")).toBeNull();
  });

  test("parseLangResult returns null for empty string", () => {
    expect(parseLangResult("")).toBeNull();
  });

  test("parseLangResult returns null for missing code field", () => {
    expect(parseLangResult('{"confidence":0.94}')).toBeNull();
  });
});
