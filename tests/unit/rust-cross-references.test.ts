import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRepoFile, repoPath } from "../helpers/repo";

/**
 * TS comments and hint strings point readers at the Rust symbol they mirror. Nothing kept those
 * pointers honest, so the #950 `models.rs` split left 14 of them aimed at a deleted file (#1132).
 */
const FILE_REFERENCE = /\b((?:rust\/)?(?:[a-z0-9_]+\/)*[a-z0-9_]+\.rs)(?:::([A-Za-z0-9_]+))?/g;

/** The `mod::sym` form carries no `.rs`; the lookbehind keeps `init.ts::initCommand` and paths out. */
const MODULE_REFERENCE = /(?<![\w./])([a-z][a-z0-9_]*(?:::[a-z][a-z0-9_]*)*)::([A-Za-z0-9_]+)/g;

const DECLARATION = "(?:fn|const|static|struct|enum|trait|type|union|mod|macro_rules!)";

/** Blanks Rust comments and literals, so declaration-shaped prose inside one cannot satisfy `declares` (#1132 round 2). */
function stripCommentsAndLiterals(source: string): string {
  let code = "";
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    if (rest.startsWith("//")) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source.startsWith("/*", i)) (depth++, (i += 2));
        else if (source.startsWith("*/", i)) (depth--, (i += 2));
        else i++;
      }
      continue;
    }
    const previous = code.at(-1);
    if (!previous || !/[A-Za-z0-9_]/.test(previous)) {
      const raw = /^b?r(#*)"/.exec(rest);
      if (raw) {
        const close = `"${raw[1]}`;
        const end = source.indexOf(close, i + raw[0].length);
        i = end === -1 ? source.length : end + close.length;
        continue;
      }
      const quoted = /^b?"/.exec(rest);
      if (quoted) {
        i += quoted[0].length;
        while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      const character = /^'(?:\\.|[^\\'])'/.exec(rest);
      if (character) {
        i += character[0].length;
        continue;
      }
    }
    code += source[i];
    i++;
  }
  return code;
}

/**
 * A declaration, not a mention: a `use` line, a call site, a doc comment or a string must not
 * satisfy a pointer, or every symbol could be retargeted at `models/mod.rs`'s re-export block.
 */
function declares(source: string, symbol: string): boolean {
  return new RegExp(`\\b${DECLARATION}\\s+${symbol}\\b`).test(stripCommentsAndLiterals(source));
}

function tsSources(dir: string): string[] {
  return readdirSync(repoPath(dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** `rust/…` is repo-relative on purpose: `rust/build.rs` and `rust/tests/*.rs` are legal targets. */
function resolveFile(path: string): string {
  return path.startsWith("rust/") ? path : `rust/src/${path}`;
}

function resolveModule(path: string): string | undefined {
  const base = `rust/src/${path.split("::").join("/")}`;
  return [`${base}.rs`, `${base}/mod.rs`].find((candidate) => existsSync(repoPath(candidate)));
}

type Reference = { origin: string; label: string; file?: string; symbol?: string; kind: string };

function referencesIn(origin: string): Reference[] {
  const source = readRepoFile(origin);
  const files = [...source.matchAll(FILE_REFERENCE)].flatMap<Reference>(([, path, symbol]) =>
    path
      ? [
          {
            origin,
            label: symbol ? `${path}::${symbol}` : path,
            file: resolveFile(path),
            symbol,
            kind: symbol ? "file-with-symbol" : "file",
          },
        ]
      : [],
  );
  const modules = [...source.matchAll(MODULE_REFERENCE)].flatMap<Reference>(([, path, symbol]) =>
    path && symbol
      ? [{ origin, label: `${path}::${symbol}`, file: resolveModule(path), symbol, kind: "module" }]
      : [],
  );
  return [...files, ...modules];
}

const references: Reference[] = tsSources("src").flatMap(referencesIn);

const countOf = (kind: string) => references.filter((reference) => reference.kind === kind).length;

describe("declares", () => {
  const cases: Array<[string, string, boolean]> = [
    ["pub(super) const ANE_EN_FILES: &[ModelFile] = &[];", "ANE_EN_FILES", true],
    ["pub fn helper_path() -> PathBuf {}", "helper_path", true],
    ["macro_rules! trace_fmt {}", "trace_fmt", true],
    ["// fn helper_path() — removed in #269", "helper_path", false],
    ["/// Superseded by `fn helper_path`.", "helper_path", false],
    ["/* fn helper_path() */", "helper_path", false],
    ["/* outer /* fn helper_path() */ still comment */", "helper_path", false],
    ['const DOC: &str = "const helper_path";', "helper_path", false],
    ['let s = r#"pub fn helper_path()"#;', "helper_path", false],
    ['let s = "escaped \\" fn helper_path";', "helper_path", false],
    ["use crate::text_lang::helper_path;", "helper_path", false],
    ["let p = helper_path();", "helper_path", false],
  ];

  for (const [source, symbol, expected] of cases) {
    test(`${expected ? "accepts" : "rejects"} ${JSON.stringify(source)}`, () => {
      expect(declares(source, symbol)).toBe(expected);
    });
  }
});

describe("Rust cross-references in TS sources", () => {
  // Per shape, not a global total: a narrowing that loses one whole form must not pass on the others (#1132 round 1).
  test("the scan finds every shape it is meant to gate", () => {
    expect(countOf("file-with-symbol")).toBeGreaterThanOrEqual(20);
    expect(countOf("file")).toBeGreaterThanOrEqual(2);
    expect(countOf("module")).toBeGreaterThanOrEqual(1);
  });

  test("every referenced Rust file exists", () => {
    const dangling = references
      .filter(({ file }) => !file || !existsSync(repoPath(file)))
      .map(({ origin, label }) => `${origin} → ${label}`);
    expect(dangling).toEqual([]);
  });

  test("every referenced Rust symbol is declared in the file it names", () => {
    const missing = references
      .filter(({ file, symbol }) => symbol && file && existsSync(repoPath(file)) && !declares(readRepoFile(file), symbol))
      .map(({ origin, label }) => `${origin} → ${label}`);
    expect(missing).toEqual([]);
  });
});
