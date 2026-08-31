import { describe, expect, test } from "bun:test";
import {
  coveringTests,
  importedModules,
  mutableSourceRejection,
  noSuiteRefusal,
  rankCoveringTests,
  reachableModules,
  selectCoveringTests,
  testFileCandidates,
  toPosix,
} from "../../scripts/mutants-ts";
import { REPO_ROOT } from "../helpers/repo";

/**
 * Under `coverageAnalysis: "perTest"` a suite that never loads the mutant cannot kill it, so an
 * extra suite costs runtime and nothing else. A missed one turns a killed mutant into a survivor
 * — a gap reported where none exists. Selection therefore errs towards reaching too far.
 */
describe("which suites are measured against a source", () => {
  const suite = (path: string, text: string) => ({ path, text });
  const modules = (files: Record<string, string>) => (path: string) => files[path] ?? null;
  const none = () => null;

  test("a suite that imports the source is selected", () => {
    const tests = [
      suite("tests/unit/engine.test.ts", 'import { runEngine } from "../../src/engine";'),
      suite("tests/unit/star.test.ts", 'import { star } from "../../src/star";'),
    ];

    expect(selectCoveringTests(["src/engine.ts"], tests, none)).toEqual([
      "tests/unit/engine.test.ts",
    ]);
  });

  // `src/engine` is a prefix of `src/engine-install`, so a substring match over-selects.
  test("a longer neighbour is not mistaken for the source", () => {
    const tests = [
      suite("tests/unit/engine-install.test.ts", 'import { installEngine } from "../../src/engine-install";'),
      suite("tests/unit/engine-targets.test.ts", 'import { engineTarget } from "../../src/engine-targets";'),
    ];

    expect(selectCoveringTests(["src/engine.ts"], tests, none)).toEqual([]);
  });

  // src/cli.ts is a re-export shim, so cli.test.ts exercises src/cli/main.ts without naming it.
  test("a source reached only through a re-export shim is still measured", () => {
    const tests = [suite("tests/unit/cli.test.ts", 'import { createMainCommand } from "../../src/cli";')];
    const files = modules({ "src/cli": 'export { createMainCommand } from "./cli/main";' });

    expect(selectCoveringTests(["src/cli/main.ts"], tests, files)).toEqual([
      "tests/unit/cli.test.ts",
    ]);
  });

  test("a source reached through a test helper is still measured", () => {
    const tests = [suite("tests/unit/gate.test.ts", 'import { gate } from "../helpers/model-gate";')];
    const files = modules({
      "tests/helpers/model-gate": 'import { probe } from "../../src/engine-health";',
    });

    expect(selectCoveringTests(["src/engine-health.ts"], tests, files)).toEqual([
      "tests/unit/gate.test.ts",
    ]);
  });

  test("the walk terminates on a cycle, and records how far each module is", () => {
    const files = modules({
      "src/a": 'import { b } from "./b";',
      "src/b": 'import { a } from "./a";\nimport { c } from "./c";',
      "src/c": "export const c = 1;",
    });

    expect(reachableModules("src/a.ts", files)).toEqual(
      new Map([
        ["src/b", 1],
        ["src/c", 2],
      ]),
    );
  });

  // The Bun runner stops answering above ~30 suites, so the cap decides what gets measured.
  test("direct importers outrank suites that only reach the source through a shim", () => {
    const tests = [
      suite("tests/unit/via-shim.test.ts", 'import { m } from "../../src/cli";'),
      suite("tests/unit/direct.test.ts", 'import { m } from "../../src/cli/main";'),
    ];
    const files = modules({ "src/cli": 'export { m } from "./cli/main";' });

    expect(rankCoveringTests(["src/cli/main.ts"], tests, files)).toEqual([
      { path: "tests/unit/direct.test.ts", hops: 1 },
      { path: "tests/unit/via-shim.test.ts", hops: 2 },
    ]);
  });

  // This suite is itself the case: its fixtures quote paths it does not import.
  test("a path that only appears inside a string literal is not an import", () => {
    const tests = [
      suite("tests/unit/fixtures.test.ts", 'const sample = "../../src/star";'),
      suite("tests/unit/real.test.ts", 'import { star } from "../../src/star";'),
    ];

    expect(selectCoveringTests(["src/star.ts"], tests, none)).toEqual(["tests/unit/real.test.ts"]);
  });

  test("dynamic imports and re-exports count as dependencies", () => {
    const tests = [
      suite("tests/unit/lazy.test.ts", 'const mod = await import("../../src/star");'),
      suite("tests/unit/reexport.test.ts", 'export { star } from "../../src/star";'),
    ];

    expect(selectCoveringTests(["src/star.ts"], tests, none)).toEqual([
      "tests/unit/lazy.test.ts",
      "tests/unit/reexport.test.ts",
    ]);
  });

  // Windows `path.relative` returns `src\engine`, which matches no import specifier (#897).
  test("separators are normalised before anything is compared", () => {
    expect(toPosix("tests\\unit\\engine.test.ts")).toBe("tests/unit/engine.test.ts");
    expect(importedModules("tests/unit/say.test.ts", 'import { s } from "../../src/cli/say";')).toEqual([
      "src/cli/say",
    ]);
  });

  // Integration suites spawn the CLI and the engine, so they cost minutes rather than seconds.
  test("the repository's unit suites are discovered, and integration only on request", () => {
    const found = testFileCandidates();

    expect(found).toContain("tests/unit/engine.test.ts");
    expect(found).not.toContain("tests/integration/cli-contracts.test.ts");
    expect(found.every((path) => path.endsWith(".test.ts"))).toBe(true);
    expect(testFileCandidates(["tests/integration"])).toContain(
      "tests/integration/cli-contracts.test.ts",
    );
  });
});

/**
 * The enumerator used to accept `src/` alone, so the CI gates and the repo's own scripts —
 * the code that enforces every rule in CLAUDE.md — could not be mutated at all (#1091).
 */
describe("which sources may be mutated", () => {
  test("the CLI, the repo scripts and the CI gates are all mutable", () => {
    expect(mutableSourceRejection("src/voice-routing.ts")).toBeNull();
    expect(mutableSourceRejection("scripts/mutate.ts")).toBeNull();
    expect(mutableSourceRejection(".github/scripts/check-workflows.ts")).toBeNull();
  });

  // The release path — dist-tag, version bumps, the Homebrew formula — is `.mjs` (#1091 review).
  test("the .mjs gates are mutable too", () => {
    expect(mutableSourceRejection(".github/scripts/npm-dist-tag.mjs")).toBeNull();
    expect(mutableSourceRejection(".github/scripts/update-homebrew-tap.mjs")).toBeNull();
  });

  test("a file in neither mutable language is rejected", () => {
    expect(mutableSourceRejection("src/engine.json")).toContain("src/engine.json");
    expect(mutableSourceRejection("rust/src/main.rs")).toContain("rust/src/main.rs");
    expect(mutableSourceRejection(".github/scripts/npm-dist-tag.d.mts")).not.toBeNull();
  });

  test("a TypeScript file outside every mutable root is rejected", () => {
    expect(mutableSourceRejection("tests/unit/engine.test.ts")).not.toBeNull();
    expect(mutableSourceRejection("raycast/src/index.ts")).not.toBeNull();
  });

  // `relative()` renders a path outside the repo as `../…`, which no root prefix may swallow.
  test("a path outside the repository is rejected", () => {
    expect(mutableSourceRejection("../other-worktree/src/engine.ts")).not.toBeNull();
  });

  // Whole message, not `toContain`: that reads `src/scripts/.github/scripts/` as three roots.
  test("the rejection lists every accepted root, legibly", () => {
    expect(mutableSourceRejection("docs/notes.ts")).toBe(
      "not a mutable source file: docs/notes.ts — expected a .ts or .mjs file under src/, scripts/, .github/scripts/",
    );
  });
});

/**
 * The guard above is only a guard once `main` consults it: neutralising the call left the whole
 * unit suite green while `tests/unit/foo.test.ts` reached Stryker (#1091 review).
 */
describe("the command refuses before it reaches Stryker", () => {
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", `${REPO_ROOT}/scripts/mutants-ts.ts`, ...args], {
      cwd: REPO_ROOT,
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stderr };
  };

  test("an existing file outside the mutable roots is refused, not mutated", async () => {
    const { code, stderr } = await run("rust/src/main.rs");

    expect(code).toBe(2);
    expect(stderr.trim()).toBe(
      "not a mutable source file: rust/src/main.rs — expected a .ts or .mjs file under src/, scripts/, .github/scripts/",
    );
  });

  test("a gate no suite imports is refused without a hint that leads nowhere", async () => {
    const { code, stderr } = await run(".github/scripts/check-versions.ts");

    expect(code).toBe(1);
    expect(stderr.trim()).toBe(
      noSuiteRefusal([".github/scripts/check-versions.ts"], ["tests/unit"], false),
    );
    expect(stderr).not.toContain("--with-integration");
  });
});

/** Selection is by import, and a `.mjs` gate is reached only through other `.mjs` (#1091 review). */
describe("which suites measure a .mjs gate", () => {
  test("a direct importer is found", async () => {
    expect(await coveringTests([".github/scripts/npm-dist-tag.mjs"], ["tests/unit"])).toEqual([
      { path: "tests/unit/npm-dist-tag.test.ts", hops: 1 },
    ]);
  });

  test("a gate reached only through another .mjs is found too", async () => {
    const ranked = await coveringTests([".github/scripts/script-entry.mjs"], ["tests/unit"]);

    expect(ranked.map((test) => test.path)).toContain("tests/unit/release-tag-grammar.test.ts");
  });
});

describe("the refusal when nothing measures a source", () => {
  test("the retry is named only when the integration root would find suites", () => {
    expect(noSuiteRefusal(["src/foo.ts"], ["tests/unit"], true)).toContain(
      "(retry with --with-integration)",
    );
    expect(noSuiteRefusal(["src/foo.ts"], ["tests/unit"], false)).not.toContain("--with-integration");
  });
});
