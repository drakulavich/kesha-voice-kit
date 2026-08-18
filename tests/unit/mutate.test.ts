import { describe, expect, test } from "bun:test";
import { mutate } from "../../scripts/mutate";

describe("mutate", () => {
  // A perl one-liner whose pattern misses exits 0 and changes nothing, so the test passes and the
  // run reads as "the pin is useless" — that false verdict is what this counts away (#1075).
  test("reports zero replacements rather than a silent no-op", () => {
    const source = "let owner = lock();";
    expect(mutate(source, "absent", "x")).toEqual({ replacements: 0, source });
  });

  test("counts and applies every occurrence", () => {
    const result = mutate("a; b; a;", "a", "z");
    expect(result).toEqual({ replacements: 2, source: "z; b; z;" });
  });

  test("treats the needle as literal text, not a pattern", () => {
    // `.` and `(` are the common case in real guards; a regex would match far too much.
    expect(mutate("if (x) { drop(); }", "drop()", "keep()").source).toBe("if (x) { keep(); }");
    expect(mutate("a.b", ".", "!")).toEqual({ replacements: 1, source: "a!b" });
  });

  test("refuses an empty needle instead of splitting every character", () => {
    expect(() => mutate("abc", "", "x")).toThrow("must not be empty");
  });
});
