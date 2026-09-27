import { describe, expect, test } from "bun:test";
import { namedFilterOf } from "../../.github/scripts/check-workflows";
import { parseRepoYaml } from "../helpers/repo";

type Job = { if?: string; needs?: string[] | string; uses?: string; steps?: { uses?: string }[] };
const CI = ".github/workflows/ci.yml";
const ci = parseRepoYaml(CI) as { jobs: Record<string, Job> };
const filter = (name: string) => {
  const result = namedFilterOf(CI, ci, name);
  if ("errors" in result) throw new Error(result.errors.join("\n"));
  return result.entries;
};
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

  // The path sets the two workflows triggered on, carried over whole (plus ci.yml, the lanes' new home).
  test("each lane's filter keeps its old workflow's paths", () => {
    const pr = [
      "packaging/**",
      ".github/scripts/build-linux-packages.mjs",
      ".github/scripts/linux-package-names.mjs",
      ".github/scripts/install-nfpm.sh",
      ".github/scripts/verify-linux-packages.sh",
      ".github/actions/linux-packages/action.yml",
    ];
    expect(filter("linux_packages")).toEqual(expect.arrayContaining(pr));
    expect(filter("linux_packages_main")).toEqual(
      expect.arrayContaining([...pr, ".github/workflows/release.yml", "package.json", "bun.lock", "bin/**", "src/**", "README.md", "LICENSE", "NOTICES.md"]),
    );
    expect(filter("cache_probe")).toEqual(
      expect.arrayContaining([".github/workflows/cache-seed.yml", ".github/actions/install-kesha-backend/action.yml", ".github/scripts/assert-cross-os-cache.sh"]),
    );
  });
});
