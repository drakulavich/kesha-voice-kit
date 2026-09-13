import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { readRepoFile, repoPath } from "../helpers/repo";

const SPECS = readdirSync(repoPath("openspec/specs")).map((cap) => `openspec/specs/${cap}/spec.md`).filter((p) => existsSync(repoPath(p)));
const PATH = String.raw`(?:src|rust|tests|docs|\.github|scripts|raycast|openspec)\/[A-Za-z0-9_./-]+\.[a-z]+`;
// A lookbehind, not \b: a word boundary never precedes the dot of `.github/`.
const LINE_CITATION = new RegExp(String.raw`(?<![\w/.])${PATH}:\d+(?:-\d+)?\b|` + "`:\\d+(?:-\\d+)?`", "g");
const SYMBOL_CITATION = new RegExp(String.raw`(?<![\w/.])(${PATH})::([A-Za-z_][A-Za-z0-9_-]*(?:::[A-Za-z_][A-Za-z0-9_-]*)*)`, "g");

describe("openspec technical notes cite code by symbol", () => {
  it("carry no file:line citations, which drift on every edit above the cited line", () => {
    // #1193: `file::symbol` is checkable against the tree; a line number is not.
    const drifting = SPECS.flatMap((spec) => [...readRepoFile(spec).matchAll(LINE_CITATION)].map((m) => `${spec}: ${m[0]}`));
    expect(drifting).toEqual([]);
  });

  it("name a file that exists and a symbol that file defines", () => {
    const cited = SPECS.flatMap((spec) => [...readRepoFile(spec).matchAll(SYMBOL_CITATION)].map((m) => ({ spec, file: m[1]!, symbol: m[2]! })));
    expect(cited.length).toBeGreaterThan(60);
    const unresolved = cited
      .filter(({ file, symbol }) => {
        if (!existsSync(repoPath(file))) return true;
        const leaf = symbol.split("::").at(-1)!;
        return !new RegExp(String.raw`\b${leaf}\b`).test(readRepoFile(file));
      })
      .map(({ spec, file, symbol }) => `${spec}: ${file}::${symbol}`);
    expect(unresolved).toEqual([]);
  });
});
