#!/usr/bin/env bun
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
// @ts-expect-error stryker.conf.mjs is untyped JS config; reading it keeps one source of truth.
import baseConfig from "../stryker.conf.mjs";

// Integration suites spawn the CLI and the engine, and a dry run including one of them times
// out however few suites there are — measured on src/engine.ts with four. Opt in with
// --with-integration when the source is only exercised across that boundary.
const TEST_ROOTS = ["tests/unit"];
const INTEGRATION_ROOT = "tests/integration";
// The Bun runner's dry run stops answering on a large set — the limit stryker.conf.mjs
// documents, met from the other side. It is cost- rather than count-shaped: 12 light suites
// ran, 15 engine-spawning ones did not, and neither timeoutMS, dryRunTimeoutMinutes nor
// bun.timeout moves it. Suites are added a hop-tier at a time while the total fits.
const MAX_SUITES = 12;
const GENERATED_CONFIG = `stryker.generated.${process.pid}.json`;

const USAGE = [
  "usage: bun scripts/mutants-ts.ts [--with-integration] <src/file.ts> [more.ts ...]",
  "",
  "Mutation-tests the named sources against whichever suites import them.",
  "A survivor is an edit no test noticed — read it as a missing assertion,",
  "not as a number to drive up. CLAUDE.md names the kinds worth leaving alive.",
].join("\n");

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
 * source through a shim. The order is what makes the cap in `main` defensible.
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

/**
 * Whole hop-tiers while they fit: mixing half of a tier in would make the reported score depend
 * on filename order. Always yields the nearest tier, even when that one alone is over budget —
 * measuring the closest suites beats refusing to measure.
 */
export function takeNearestTiers<T extends { hops: number }>(ranked: T[], max: number): T[] {
  const kept: T[] = [];
  for (let i = 0; i < ranked.length; ) {
    const hops = ranked[i]!.hops;
    const tier = ranked.slice(i).filter((test) => test.hops === hops);
    if (kept.length > 0 && kept.length + tier.length > max) break;
    kept.push(...tier);
    i += tier.length;
  }
  return kept;
}

export function selectCoveringTests(
  sources: string[],
  tests: Array<{ path: string; text: string }>,
  readModule: (path: string) => string | null,
): string[] {
  return rankCoveringTests(sources, tests, readModule).map((test) => test.path);
}

/** Resolves an extensionless module path the way the bundler does: `x.ts`, then `x/index.ts`. */
function readModuleSync(path: string): string | null {
  for (const candidate of [`${path}.ts`, `${path}.tsx`, join(path, "index.ts")]) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
  }
  return null;
}

async function coveringTests(
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
    if (!source.startsWith("src/") || !source.endsWith(".ts")) {
      console.error(`not a mutable source file: ${source}`);
      return 2;
    }
    if (!(await Bun.file(source).exists())) {
      console.error(`no such file: ${source}`);
      return 2;
    }
  }

  const ranked = await coveringTests(sources, roots);
  if (ranked.length === 0) {
    console.error(
      `no suite in ${roots.join(", ")} reaches ${sources.join(", ")} — mutation testing measures assertions, so there is nothing to measure yet${withIntegration ? "" : " (retry with --with-integration)"}`,
    );
    return 1;
  }

  const kept = takeNearestTiers(ranked, MAX_SUITES);
  const testFiles = kept.map((test) => test.path);
  console.error(`mutating ${sources.join(", ")} against ${testFiles.length} suite(s):`);
  for (const test of kept) console.error(`  ${test.path}${test.hops > 1 ? ` (${test.hops} hops)` : ""}`);
  const dropped = ranked.slice(kept.length);
  if (dropped.length > 0) {
    console.error(
      `not measured: ${dropped.length} further suite(s) reach these sources, but the Bun runner's dry run stops answering on a set this size. A survivor below may still be killed by:`,
    );
    for (const test of dropped) console.error(`  ${test.path} (${test.hops} hops)`);
  }

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
