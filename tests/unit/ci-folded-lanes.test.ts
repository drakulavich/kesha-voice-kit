import { describe, expect, test } from "bun:test";
import { parseRepoYaml } from "../helpers/repo";

type Job = { if?: string; needs?: string[] | string; uses?: string; steps?: { uses?: string }[] };
const ci = parseRepoYaml(".github/workflows/ci.yml") as { jobs: Record<string, Job> };
const needs = (job: string) => [ci.jobs[job]?.needs].flat();

// The lanes that had their own workflows (openspec unified-release D4) keep their triggers inside ci.yml.
describe("lanes folded into ci.yml", () => {
  test("linux-packages builds through the shared composite on a matching PR and a matching main push, never on schedule", () => {
    const job = ci.jobs["linux-packages"]!;
    expect(job.steps?.some((s) => s.uses === "./.github/actions/linux-packages")).toBe(true);
    expect(job.if).toContain("github.event_name == 'pull_request' && needs.changes.outputs.linux_packages == 'true'");
    expect(job.if).toContain("github.event_name == 'push' && needs.changes.outputs.linux_packages_main == 'true'");
    expect(job.if).not.toContain("schedule");
  });

  test("the cross-OS cache probe runs its three jobs in order on a matching PR only", () => {
    expect(ci.jobs["cache-probe-save"]!.if).toBe("github.event_name == 'pull_request' && needs.changes.outputs.cache_probe == 'true'");
    expect(needs("cache-probe-restore")).toContain("cache-probe-save");
    expect(needs("cache-probe-cleanup")).toContain("cache-probe-restore");
    expect(ci.jobs["cache-probe-cleanup"]!.if).toContain("needs.cache-probe-save.result != 'skipped'");
  });
});
