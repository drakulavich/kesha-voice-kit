import { describe, test, expect } from "bun:test";
import { suggestCommand } from "../../src/suggest-command";

describe("suggestCommand", () => {
  const commands = ["help", "test", "run"];

  test("suggests 'help' for 'hlep'", () => {
    expect(suggestCommand("hlep", commands)).toBe("help");
  });

  test("suggests 'test' for 'tset'", () => {
    expect(suggestCommand("tset", commands)).toBe("test");
  });

  test("suggests 'run' for 'ru'", () => {
    expect(suggestCommand("ru", commands)).toBe("run");
  });

  test("returns null for 'xyzabc'", () => {
    expect(suggestCommand("xyzabc", commands)).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(suggestCommand("", commands)).toBeNull();
  });

  test("returns exact match for 'help'", () => {
    expect(suggestCommand("help", commands)).toBe("help");
  });

  test("case-insensitive: 'Help' matches 'help'", () => {
    expect(suggestCommand("Help", commands)).toBe("help");
  });

  test("suggests 'test' for 'tes'", () => {
    expect(suggestCommand("tes", commands)).toBe("test");
  });

  test("suggests 'run' for 'runx'", () => {
    expect(suggestCommand("runx", commands)).toBe("run");
  });

  test("returns null for empty commands list", () => {
    expect(suggestCommand("foo", [])).toBeNull();
  });
});
