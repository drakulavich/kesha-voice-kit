#!/usr/bin/env bun
import { readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
// @ts-expect-error stryker.conf.mjs is untyped JS config; reading it keeps one source of truth.
import baseConfig from "../stryker.conf.mjs";

const TEST_ROOTS = ["tests/unit", "tests/integration"];
const GENERATED_CONFIG = "stryker.generated.json";

const USAGE = [
  "usage: bun scripts/mutants-ts.ts <src/file.ts> [more.ts ...]",
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
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith(".test.ts") ? [path] : [];
    });
  };
  return roots.flatMap(walk);
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/**
 * Resolved, extensionless module paths a test actually depends on. Parsed rather than
 * grepped: a suite whose fixtures quote an import statement — this repo has one — is not
 * a dependency of what that string names.
 */
export function importedModules(testPath: string, text: string): string[] {
  let scanned: ReturnType<typeof transpiler.scanImports>;
  try {
    scanned = transpiler.scanImports(text);
  } catch (err) {
    throw new Error(`could not parse ${testPath} to find its imports: ${err}`);
  }
  return scanned
    .map(({ path }) => path)
    .filter((path) => path.startsWith("."))
    .map((path) => relative(process.cwd(), resolve(dirname(testPath), path)).replace(/\.ts$/, ""));
}

export function selectCoveringTests(
  sources: string[],
  tests: Array<{ path: string; text: string }>,
): string[] {
  const wanted = new Set(sources.map((source) => source.replace(/\.ts$/, "")));
  return tests
    .filter((test) => importedModules(test.path, test.text).some((mod) => wanted.has(mod)))
    .map((test) => test.path);
}

async function coveringTests(sources: string[]): Promise<string[]> {
  const tests = await Promise.all(
    testFileCandidates().map(async (path) => ({ path, text: await Bun.file(path).text() })),
  );
  return selectCoveringTests(sources, tests);
}

async function main(argv: string[]): Promise<number> {
  const sources = argv.map((arg) => relative(process.cwd(), resolve(arg)));
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

  const testFiles = await coveringTests(sources);
  if (testFiles.length === 0) {
    console.error(
      `no suite imports ${sources.join(", ")} — mutation testing measures assertions, so there is nothing to measure yet`,
    );
    return 1;
  }

  console.error(`mutating ${sources.join(", ")} against ${testFiles.length} suite(s):`);
  for (const test of testFiles) console.error(`  ${test}`);

  // Written beside stryker.conf.mjs on purpose: `ignorePatterns` resolve against the config's
  // directory, and a config outside the repo root sends the sandbox copy into rust/target.
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
    rmSync(GENERATED_CONFIG, { force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
