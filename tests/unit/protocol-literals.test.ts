import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { repoPath } from "../helpers/repo";

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts") && !p.includes("__tests__")) out.push(p);
  }
  return out;
}

const RENDERER = "src/engine/events.ts";
const files = sources(repoPath("src")).map((p) => [relative(repoPath("."), p).replace(/\\/g, "/"), readFileSync(p, "utf8")] as const);
const documented = new Set(
  [...readFileSync(repoPath("docs/errors.md"), "utf8").matchAll(/^\| `(E_[A-Z0-9_]+)`/gm)].map((m) => m[1]!),
);

describe("the protocol 3 surface is gone from src/", () => {
  test("only the renderer writes the `error [CODE]:` line", () => {
    const offenders = files.filter(([path, text]) => path !== RENDERER && /error \\?\[/.test(text)).map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  test.each(["KESHA_DEBUG_FD", "--capabilities-json", "--error-codes-json", "TS_NATIVE_CODES"])("%s is not referenced", (needle) => {
    expect(files.filter(([, text]) => text.includes(needle)).map(([p]) => p)).toEqual([]);
  });

  test("every error code the CLI names is documented in docs/errors.md", () => {
    const named = new Map<string, string>();
    for (const [path, text] of files) {
      for (const m of text.matchAll(/"(E_[A-Z0-9_]+)"/g)) named.set(m[1]!, path);
    }
    const undocumented = [...named].filter(([code]) => !documented.has(code));
    expect(undocumented).toEqual([]);
    expect(documented.size).toBeGreaterThan(20);
  });
});

describe("the protocol 3 surface is gone from tests/", () => {
  test.each(["--capabilities-json", "--error-codes-json", "KESHA_DEBUG_FD"])("no test stub answers %s any more", (needle) => {
    const stubs = sources(repoPath("tests"))
      .map((p) => [relative(repoPath("."), p).replace(/\\/g, "/"), readFileSync(p, "utf8")] as const)
      .filter(([path, text]) => path !== "tests/unit/protocol-literals.test.ts" && text.includes(needle))
      .map(([p]) => p);
    expect(stubs).toEqual([]);
  });
});
