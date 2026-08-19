import { describe, expect, test } from "bun:test";
import { mutate, verdict } from "../../scripts/mutate";

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

describe("verdict", () => {
  const log = ["compiling", "running", "(fail) it refuses", "1 fail", "Ran 3 tests"].join("\n");

  test("a caught mutation reports the run's last lines, not the failure it was asking for", () => {
    const result = verdict({ exitCode: 1, log }, 2);

    expect(result.pinned).toBe(true);
    expect(result.report).toBe("1 fail\nRan 3 tests");
    expect(result.report).not.toContain("compiling");
  });

  // A test command that never ran a test — a build error, a filter matching nothing — exits
  // non-zero and would otherwise read exactly like a caught assertion.
  test("keeps enough of a caught run to tell an assertion from a command that never ran", () => {
    const result = verdict({ exitCode: 101, log: "error: could not compile `kesha-engine`" }, 2);

    expect(result.report).toContain("could not compile");
  });

  test("a surviving mutation reports the whole run, because nothing failed to point at", () => {
    const result = verdict({ exitCode: 0, log }, 2);

    expect(result.pinned).toBe(false);
    expect(result.report).toBe(log);
  });
});
