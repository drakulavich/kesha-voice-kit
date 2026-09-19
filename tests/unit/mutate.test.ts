import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mutate } from "../../scripts/mutate";
import { tempDir } from "../helpers/temp-dir";

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

const MUTATE = join(import.meta.dir, "../../scripts/mutate.ts");
const ORIGINAL = "if (locked) return;\nrun();\n";
const NEEDLE = "if (locked) return;";
const SEPARATOR = "\n---\n";

/** A target file plus a log every test command appends the target's content to, so a test can prove which content each run saw. */
function scenario(): { dir: string; target: string; log: string; script: (name: string, body: string) => string } {
  const dir = tempDir("mutate-");
  const target = join(dir, "target.ts");
  const log = join(dir, "seen.log");
  writeFileSync(target, ORIGINAL);
  writeFileSync(log, "");
  return {
    dir,
    target,
    log,
    script(name, body) {
      const path = join(dir, name);
      writeFileSync(path, body);
      return path;
    },
  };
}

const RECORD = `import { appendFileSync, readFileSync } from "node:fs";
const [target, log] = process.argv.slice(2);
const text = readFileSync(target, "utf8");
appendFileSync(log, text + ${JSON.stringify(SEPARATOR)});
`;

async function runMutate(args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([process.execPath, MUTATE, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { exitCode, stderr, stdout };
}

function seen(log: string): string[] {
  return readFileSync(log, "utf8").split(SEPARATOR).slice(0, -1);
}

describe("bun scripts/mutate.ts — the green baseline (#1155)", () => {
  test("a test command that fails before any mutation is NOT A VALID RUN, exit 3, and the mutated text is never written", async () => {
    const s = scenario();
    const fail = s.script("fail.ts", `${RECORD}process.exit(1);\n`);
    const run = await runMutate([s.target, NEEDLE, "", process.execPath, fail, s.target, s.log]);
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain(
      "NOT A VALID RUN: the test command failed before any mutation (exit 1) — fix the command, cwd or build first",
    );
    expect(run.stderr).not.toContain("PINNED");
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
    expect(seen(s.log)).toEqual([ORIGINAL]);
  });

  test("baseline green and mutated red is PINNED, exit 0, with the file restored", async () => {
    const s = scenario();
    const check = s.script("check.ts", `${RECORD}process.exit(text.includes("locked") ? 0 : 1);\n`);
    const run = await runMutate([s.target, NEEDLE, "", process.execPath, check, s.target, s.log]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("PINNED: the mutation was caught");
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
    expect(seen(s.log)).toEqual([ORIGINAL, "\nrun();\n"]);
  });

  test("baseline green and mutated still green is NOT PINNED, exit 1", async () => {
    const s = scenario();
    const pass = s.script("pass.ts", `${RECORD}process.exit(0);\n`);
    const run = await runMutate([s.target, NEEDLE, "", process.execPath, pass, s.target, s.log]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("NOT PINNED: the mutation survived");
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
    expect(seen(s.log)).toEqual([ORIGINAL, "\nrun();\n"]);
  });
});
