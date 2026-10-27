import { describe, expect, test } from "bun:test";
import { parseRepoYaml, readRepoFile } from "../helpers/repo";

type Step = { run?: string };
const steps = (parseRepoYaml(".github/workflows/ci.yml") as { jobs: Record<string, { steps: Step[] }> }).jobs["workflow-lint"]!.steps;
const index = (pattern: RegExp) => steps.findIndex((s) => pattern.test(s.run ?? ""));

// openspec unified-release D5: actionlint owns syntax, expressions and shellcheck, pinned and verified.
describe("the actionlint lane", () => {
  test("installs pinned, hash-verified actionlint and shellcheck before running actionlint", () => {
    const install = index(/install-actionlint\.sh/);
    const run = index(/^actionlint\b/);
    expect(install).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(install);
    const script = readRepoFile(".github/scripts/install-actionlint.sh");
    for (const tool of ["ACTIONLINT", "SHELLCHECK"]) {
      expect(script).toMatch(new RegExp(`^${tool}_VERSION="\\d+\\.\\d+\\.\\d+"$`, "m"));
      expect(script).toMatch(new RegExp(`^${tool}_SHA256="[0-9a-f]{64}"$`, "m"));
    }
  });

  // Scope the compatibility exception to release.yml, where GitHub accepts queue: max.
  test("ignores only release.yml's concurrency.queue key", () => {
    const run = steps[index(/^actionlint\b/)]!.run!;
    expect(run).toBe("actionlint");
    const config = readRepoFile(".github/actionlint.yaml");
    expect(config).toMatch(/\.github\/workflows\/release\.yml:\s+ignore:\s+- 'unexpected key "queue" for "concurrency" section'/);
  });
});
