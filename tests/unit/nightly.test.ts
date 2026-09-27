import { describe, expect, test } from "bun:test";
import { parseRepoYaml } from "../helpers/repo";

type Job = { if?: string; concurrency?: { group?: string }; strategy?: { matrix?: unknown } };
const nightly = parseRepoYaml(".github/workflows/nightly.yml") as {
  on: { schedule: { cron: string }[]; workflow_dispatch: { inputs: { job: { options: string[] } } } };
  jobs: Record<string, Job>;
};
const crons = nightly.on.schedule.map((s) => s.cron);
const jobs = Object.entries(nightly.jobs);

// A job whose cron the trigger list lacks never runs, and two jobs on one cron run together.
describe("nightly.yml", () => {
  // The whole condition, not a substring: `… || true` would otherwise pass while running on every cron.
  test("every job runs only on its own cron or its own dispatch, and every cron has exactly one job", () => {
    const owned = jobs.map(([name, job]) => {
      const mine = crons.filter((cron) => job.if?.includes(`github.event.schedule == '${cron}'`));
      expect([name, mine.length]).toEqual([name, 1]);
      expect([name, job.if]).toEqual([
        name,
        `github.event.schedule == '${mine[0]}' || (github.event_name == 'workflow_dispatch' && inputs.job == '${name}')`,
      ]);
      return mine[0];
    });
    expect([...owned].sort()).toEqual([...crons].sort());
  });

  test("the dispatch input offers exactly the jobs", () => {
    expect([...nightly.on.workflow_dispatch.inputs.job.options].sort()).toEqual(jobs.map(([name]) => name).sort());
  });

  // A group holds one running and one pending job, so matrix rows sharing one would evict each other.
  test("a matrix job's concurrency group is per row", () => {
    for (const [name, job] of jobs.filter(([, job]) => job.strategy?.matrix)) {
      expect([name, job.concurrency?.group]).toEqual([name, expect.stringContaining("${{ matrix.")]);
    }
  });
});
