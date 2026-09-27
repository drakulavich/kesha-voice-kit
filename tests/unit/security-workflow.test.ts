import { describe, expect, test } from "bun:test";
import { parseRepoYaml } from "../helpers/repo";

type Job = { name?: string; if?: string; needs?: string[] };
const security = parseRepoYaml(".github/workflows/security.yml") as {
  on: Record<string, { branches?: string[] } | null>;
  jobs: Record<string, Job>;
};

// The plugin scan moved in from its own workflow (openspec unified-release D4); the audits kept their triggers.
describe("security.yml", () => {
  test("the plugin scan runs on every pull request and every push to main, under its old check name", () => {
    const scan = security.jobs["plugin-scan"]!;
    expect(security.on.push?.branches).toEqual(["main"]);
    expect(scan.name).toBe("🛡️ Plugin Security Scan");
    expect(scan.if).toBe("github.event_name == 'pull_request' || github.event_name == 'push'");
  });

  test("a push to main runs no audit, and the scan never gates the required check", () => {
    for (const audit of ["cargo-deny", "bun-audit"]) {
      expect([audit, security.jobs[audit]!.if]).toEqual([
        audit,
        "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && needs.changes.outputs.deps == 'true')",
      ]);
    }
    expect(security.jobs["security-audit"]!.needs).not.toContain("plugin-scan");
  });
});
