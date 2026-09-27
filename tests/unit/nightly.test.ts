import { describe, expect, test } from "bun:test";
import { parseRepoYaml } from "../helpers/repo";

type Job = { if?: string };
const nightly = parseRepoYaml(".github/workflows/nightly.yml") as {
  on: { schedule: { cron: string }[]; workflow_dispatch: { inputs: { job: { options: string[] } } } };
  jobs: Record<string, Job>;
};
const crons = nightly.on.schedule.map((s) => s.cron);
const jobs = Object.entries(nightly.jobs);

// A job whose cron the trigger list lacks never runs, and two jobs on one cron run together.
describe("nightly.yml", () => {
  test("every job runs on exactly one scheduled cron, and no cron is left without a job", () => {
    const owned = jobs.map(([name, job]) => {
      const mine = crons.filter((cron) => job.if?.includes(`github.event.schedule == '${cron}'`));
      expect([name, mine.length]).toEqual([name, 1]);
      return mine[0];
    });
    expect([...owned].sort()).toEqual([...crons].sort());
  });

  test("every job can be dispatched alone, and the dispatch input offers exactly the jobs", () => {
    for (const [name, job] of jobs) {
      expect(job.if).toContain(`github.event_name == 'workflow_dispatch' && inputs.job == '${name}'`);
    }
    expect([...nightly.on.workflow_dispatch.inputs.job.options].sort()).toEqual(jobs.map(([name]) => name).sort());
  });
});
