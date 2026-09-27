import { describe, expect, test } from "bun:test";
import { parseRepoYaml } from "../helpers/repo";

type Job = { name?: string; if?: string; needs?: string[] };
const ci = parseRepoYaml(".github/workflows/ci.yml") as { jobs: Record<string, Job> };

// rust-test.yml's lanes moved into ci.yml (openspec unified-release D4); the required check keeps its name.
describe("the Rust lanes in ci.yml", () => {
  test("🧪 Rust Tests aggregates every Rust lane, and always reports", () => {
    const gate = ci.jobs["rust-tests"]!;
    expect(gate.name).toBe("🧪 Rust Tests");
    expect(gate.if).toBe("always()");
    expect([...gate.needs!].sort()).toEqual(["changes", "coreml-regression", "coverage", "lint-ubuntu", "rust-push-gate", "test"]);
  });

  test("the PR lanes run on a pull request that touches Rust, never on the schedule", () => {
    for (const lane of ["lint-ubuntu", "test", "coverage"]) {
      expect([lane, ci.jobs[lane]!.if]).toEqual([lane, "github.event_name == 'pull_request' && needs.changes.outputs.rust == 'true'"]);
    }
    expect(ci.jobs["coreml-regression"]!.if).toBe("github.event_name == 'pull_request' && needs.changes.outputs.coreml == 'true'");
  });

  test("the push gate runs on a push to main that touches what rust-test.yml's push filter named", () => {
    expect(ci.jobs["rust-push-gate"]!.if).toBe("github.event_name == 'push' && needs.changes.outputs.rust_main == 'true'");
  });
});
