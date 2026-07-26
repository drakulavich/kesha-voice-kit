import { describe, test, expect } from "bun:test";
import { suggestCommand } from "../../src/suggest-command";

describe("suggestCommand", () => {
  const commands = ["help", "test", "run"];

  test("suggests 'help' for 'hlep'", () => {
    expect(suggestCommand("hlep", commands)).toBe("help");
  });

  test("suggests the closest match for common typos/prefixes", () => {
    const cases: Array<[string, string]> = [
      ["tset", "test"],
      ["ru", "run"],
      ["tes", "test"],
      ["runx", "run"],
    ];
    for (const [input, expected] of cases) {
      expect(suggestCommand(input, commands)).toBe(expected);
    }
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

  test("returns null for empty commands list", () => {
    expect(suggestCommand("foo", [])).toBeNull();
  });
});
