import { describe, expect, test } from "bun:test";
import { parseRepoYaml, readRepoFile } from "../helpers/repo";

type Step = { run?: string };
const steps = (parseRepoYaml(".github/workflows/ci.yml") as { jobs: Record<string, { steps: Step[] }> }).jobs["workflow-lint"]!.steps;
const index = (pattern: RegExp) => steps.findIndex((s) => pattern.test(s.run ?? ""));

// openspec unified-release D5: actionlint owns syntax, expressions and shellcheck, pinned and verified.
describe("the actionlint lane", () => {
  test("installs the pinned, hash-verified binary before running it", () => {
    const install = index(/install-actionlint\.sh/);
    const run = index(/^actionlint\b/);
    expect(install).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(install);
    const script = readRepoFile(".github/scripts/install-actionlint.sh");
    expect(script).toMatch(/^VERSION="\d+\.\d+\.\d+"$/m);
    expect(script).toMatch(/^SHA256="[0-9a-f]{64}"$/m);
  });

  // A broad -ignore would silence exactly the class of error the lane exists to catch.
  test("ignores only the concurrency.queue key actionlint does not know", () => {
    const run = steps[index(/^actionlint\b/)]!.run!;
    expect([...run.matchAll(/-ignore\s+'([^']*)'/g)].map((m) => m[1])).toEqual(['unexpected key "queue" for "concurrency" section']);
  });
});
