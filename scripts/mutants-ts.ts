#!/usr/bin/env bun
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
// @ts-expect-error stryker.conf.mjs is untyped JS config; reading it keeps one source of truth.
import baseConfig from "../stryker.conf.mjs";

// Integration suites spawn the CLI and the engine, which costs minutes rather than seconds.
const TEST_ROOTS = ["tests/unit"];
const INTEGRATION_ROOT = "tests/integration";
const GENERATED_CONFIG = `stryker.generated.${process.pid}.json`;

// `src/` alone left the CI gates and the repo's own scripts unmeasurable (#1091).
const MUTABLE_ROOTS = ["src/", "scripts/", ".github/scripts/"];
// The release path under `.github/scripts/` is written in `.mjs`; `.ts` alone hid all of it (#1091 review).
const MUTABLE_EXTENSIONS = [".ts", ".mjs"];

const USAGE = [
  "usage: bun scripts/mutants-ts.ts [--with-integration] <file.ts|file.mjs> [more ...]",
  "",
  "Mutation-tests the named sources against whichever suites import them.",
  "A survivor is an edit no test noticed — read it as a missing assertion,",
  "not as a number to drive up. CLAUDE.md names the kinds worth leaving alive.",
].join("\n");

/** The reason `source` cannot be mutated, naming what is accepted, or null when it can. */
export function mutableSourceRejection(source: string): string | null {
  const mutable =
    MUTABLE_EXTENSIONS.some((extension) => source.endsWith(extension)) &&
    MUTABLE_ROOTS.some((root) => source.startsWith(root));
  if (mutable) return null;
  return `not a mutable source file: ${source} — expected a ${MUTABLE_EXTENSIONS.join(" or ")} file under ${MUTABLE_ROOTS.join(", ")}`;
}

/** The refusal when nothing measures `sources`; the retry is only named when it would find suites. */
export function noSuiteRefusal(sources: string[], roots: string[], integrationHelps: boolean): string {
  return `no suite in ${roots.join(", ")} reaches ${sources.join(", ")} — mutation testing measures assertions, so there is nothing to measure yet${integrationHelps ? " (retry with --with-integration)" : ""}`;
}

export function testFileCandidates(roots: string[] = TEST_ROOTS): string[] {
  const walk = (dir: string): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const path = toPosix(join(dir, entry));
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith(".test.ts") ? [path] : [];
    });
  };
  return roots.flatMap(walk);
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Import specifiers are always `/`-separated; `path` on Windows is not. */
export function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Resolved, extensionless module paths a file imports directly. Parsed rather than grepped:
 * a suite whose fixtures quote an import statement — this repo has one — is not a dependency
 * of what that string names.
 */
export function importedModules(fromPath: string, text: string): string[] {
  let scanned: ReturnType<typeof transpiler.scanImports>;
  try {
    // The transpiler rejects a shebang, and every executable script in this repo opens with one.
    scanned = transpiler.scanImports(text.replace(/^#!.*/, ""));
  } catch (err) {
    throw new Error(`could not parse ${fromPath} to find its imports: ${err}`);
  }
  return scanned
    .map(({ path }) => path)
    .filter((path) => path.startsWith("."))
    .map((path) => toPosix(relative(process.cwd(), resolve(dirname(fromPath), path))).replace(/\.tsx?$/, ""));
}

/**
 * Every module a test reaches, not just the ones it names. `src/cli.ts` is a re-export shim,
 * so `cli.test.ts` exercises `src/cli/main.ts` without ever mentioning it; stopping at direct
 * imports reported "no suite" for the CLI's own modules. Over-selecting is the safe direction
 * under `coverageAnalysis: "perTest"` — a suite that never loads the mutant cannot kill it,
 * it only costs runtime, whereas a missed killer is a survivor that is not really alive.
 */
export function reachableModules(
  entry: string,
  readModule: (path: string) => string | null,
): Map<string, number> {
  const start = entry.replace(/\.tsx?$/, "");
  const distance = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const text = readModule(current);
    if (text === null) continue;
    for (const next of importedModules(`${current}.ts`, text)) {
      if (distance.has(next)) continue;
      distance.set(next, distance.get(current)! + 1);
      queue.push(next);
    }
  }
  distance.delete(start);
  return distance;
}

/**
 * Covering suites, nearest first: a direct importer ranks above one that only reaches the
 * source through a shim. The order is what the run reports, not what it selects.
 */
export function rankCoveringTests(
  sources: string[],
  tests: Array<{ path: string; text: string }>,
  readModule: (path: string) => string | null,
): Array<{ path: string; hops: number }> {
  const wanted = sources.map((source) => toPosix(source).replace(/\.tsx?$/, ""));
  return tests
    .flatMap((test) => {
      const reached = reachableModules(test.path, (path) =>
        path === test.path.replace(/\.tsx?$/, "") ? test.text : readModule(path),
      );
      const hops = wanted
        .map((source) => reached.get(source))
        .filter((d): d is number => d !== undefined);
      return hops.length === 0 ? [] : [{ path: test.path, hops: Math.min(...hops) }];
    })
    .sort((a, b) => a.hops - b.hops || a.path.localeCompare(b.path));
}

export function selectCoveringTests(
  sources: string[],
  tests: Array<{ path: string; text: string }>,
  readModule: (path: string) => string | null,
): string[] {
  return rankCoveringTests(sources, tests, readModule).map((test) => test.path);
}

/** Resolves an extensionless module path the way the bundler does: `x.ts`, then `x/index.ts`; a `.mjs` specifier keeps its extension, so it resolves verbatim (#1091 review). */
function readModuleSync(path: string): string | null {
  const candidates = path.endsWith(".mjs")
    ? [path]
    : [`${path}.ts`, `${path}.tsx`, join(path, "index.ts")];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
  }
  return null;
}

export async function coveringTests(
  sources: string[],
  roots: string[],
): Promise<Array<{ path: string; hops: number }>> {
  const tests = await Promise.all(
    testFileCandidates(roots).map(async (path) => ({ path, text: await Bun.file(path).text() })),
  );
  return rankCoveringTests(sources, tests, readModuleSync);
}

async function main(argv: string[]): Promise<number> {
  const withIntegration = argv.includes("--with-integration");
  const roots = withIntegration ? [...TEST_ROOTS, INTEGRATION_ROOT] : TEST_ROOTS;
  const sources = argv
    .filter((arg) => arg !== "--with-integration")
    .map((arg) => toPosix(relative(process.cwd(), resolve(arg))));
  if (sources.length === 0) {
    console.error(USAGE);
    return 2;
  }

  for (const source of sources) {
    const rejection = mutableSourceRejection(source);
    if (rejection !== null) {
      console.error(rejection);
      return 2;
    }
    if (!(await Bun.file(source).exists())) {
      console.error(`no such file: ${source}`);
      return 2;
    }
  }

  const ranked = await coveringTests(sources, roots);
  if (ranked.length === 0) {
    // Probed rather than assumed: no integration suite imports anything under scripts/ or .github/scripts/, so the blanket hint sent the operator nowhere (#1091 review).
    const integrationHelps =
      !withIntegration && (await coveringTests(sources, [INTEGRATION_ROOT])).length > 0;
    console.error(noSuiteRefusal(sources, roots, integrationHelps));
    return 1;
  }

  const testFiles = ranked.map((test) => test.path);
  console.error(`mutating ${sources.join(", ")} against ${testFiles.length} suite(s):`);
  for (const test of ranked) console.error(`  ${test.path}${test.hops > 1 ? ` (${test.hops} hops)` : ""}`);

  // Written beside stryker.conf.mjs on purpose: `ignorePatterns` resolve against the config's
  // directory, and a config outside the repo root sends the sandbox copy into rust/target.
  const cleanup = () => rmSync(GENERATED_CONFIG, { force: true });
  // `finally` never runs on a signal, and Ctrl-C on a long run is the normal way out.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => (cleanup(), process.exit(130)));
  writeFileSync(
    GENERATED_CONFIG,
    `${JSON.stringify({ ...baseConfig, mutate: sources, bun: { ...baseConfig.bun, testFiles } }, null, 2)}\n`,
  );
  try {
    const proc = Bun.spawn(["bunx", "stryker", "run", GENERATED_CONFIG], {
      stdout: "inherit",
      stderr: "inherit",
    });
    return await proc.exited;
  } finally {
    cleanup();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
