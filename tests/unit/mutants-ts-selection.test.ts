import { describe, expect, test } from "bun:test";
import { selectCoveringTests, testFileCandidates } from "../../scripts/mutants-ts";

/**
 * Picking the wrong suites is the failure that matters here: stryker would report a healthy
 * score for tests that never touch the file, which is worse than having no tool.
 */
describe("which suites are measured against a source", () => {
  const suite = (path: string, text: string) => ({ path, text });

  test("a suite that imports the source is selected", () => {
    const tests = [
      suite("tests/unit/engine.test.ts", 'import { runEngine } from "../../src/engine";'),
      suite("tests/unit/star.test.ts", 'import { star } from "../../src/star";'),
    ];

    expect(selectCoveringTests(["src/engine.ts"], tests)).toEqual(["tests/unit/engine.test.ts"]);
  });

  // `src/engine` is a prefix of `src/engine-install`, so a substring match over-selects.
  test("a longer neighbour is not mistaken for the source", () => {
    const tests = [
      suite("tests/unit/engine-install.test.ts", 'import { installEngine } from "../../src/engine-install";'),
      suite("tests/unit/engine-targets.test.ts", 'import { engineTarget } from "../../src/engine-targets";'),
    ];

    expect(selectCoveringTests(["src/engine.ts"], tests)).toEqual([]);
  });

  test("a nested source is matched by its full path", () => {
    const tests = [
      suite("tests/unit/say-cli.test.ts", 'import { sayCommand } from "../../src/cli/say";'),
      suite("tests/unit/mcp-voices.test.ts", 'import { listVoices } from "../../src/mcp/voices";'),
    ];

    expect(selectCoveringTests(["src/cli/say.ts"], tests)).toEqual(["tests/unit/say-cli.test.ts"]);
    expect(selectCoveringTests(["src/mcp/voices.ts"], tests)).toEqual([
      "tests/unit/mcp-voices.test.ts",
    ]);
  });

  test("several sources contribute their suites once each", () => {
    const tests = [
      suite(
        "tests/unit/both.test.ts",
        'import { runEngine } from "../../src/engine";\nimport { formatBytes } from "../../src/progress";',
      ),
      suite("tests/unit/neither.test.ts", 'import { toToon } from "../../src/toon";'),
    ];

    expect(selectCoveringTests(["src/engine.ts", "src/progress.ts"], tests)).toEqual([
      "tests/unit/both.test.ts",
    ]);
  });

  // This suite is itself the case: its fixtures quote paths it does not import.
  test("a path that only appears inside a string literal is not an import", () => {
    const tests = [
      suite("tests/unit/fixtures.test.ts", 'const sample = "../../src/star";'),
      suite("tests/unit/real.test.ts", 'import { star } from "../../src/star";'),
    ];

    expect(selectCoveringTests(["src/star.ts"], tests)).toEqual(["tests/unit/real.test.ts"]);
  });

  test("dynamic imports and re-exports count as dependencies", () => {
    const tests = [
      suite("tests/unit/lazy.test.ts", 'const mod = await import("../../src/star");'),
      suite("tests/unit/reexport.test.ts", 'export { star } from "../../src/star";'),
    ];

    expect(selectCoveringTests(["src/star.ts"], tests)).toEqual([
      "tests/unit/lazy.test.ts",
      "tests/unit/reexport.test.ts",
    ]);
  });

  test("the repository's own suites are discovered", () => {
    const found = testFileCandidates();

    expect(found).toContain("tests/unit/engine.test.ts");
    expect(found).toContain("tests/integration/cli-contracts.test.ts");
    expect(found.every((path) => path.endsWith(".test.ts"))).toBe(true);
  });
});
