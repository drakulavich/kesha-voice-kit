import { describe, expect, test } from "bun:test";
import {
  computePriorityScore,
  encodePriorityMarker,
  evaluateMetrics,
  parsePriorityManifest,
  selectCurrentAssessment,
  sortQueue,
  type PriorityAssessment,
} from "../../scripts/backlog-priority";
import { metrics, prioritize, queue, type Runner } from "../../scripts/backlog-conveyor";

const assessment: PriorityAssessment = {
  version: 1,
  issue: 1036,
  provider: "opaque-scheduler",
  impact: 5,
  urgency: 4,
  unblock: 3,
  riskReduction: 2,
  confidence: 4,
  effort: 2,
  rationale: "Unblocks a visible lifecycle decision.",
};

describe("backlog priority", () => {
  test("derives the documented score and rejects caller supplied scores", () => {
    expect(computePriorityScore(assessment)).toBe(84);
    expect(() => parsePriorityManifest({ ...assessment, score: 999 })).toThrow("must not include score");
    expect(() => parsePriorityManifest({ ...assessment, impact: 6 })).toThrow("impact must be an integer between 0 and 5");
  });

  test("newest trusted marker supersedes an older marker without treating provider as identity", () => {
    const older = { ...assessment, provider: "one", rationale: "Earlier assessment." };
    const newest = { ...assessment, provider: "anything-opaque", urgency: 5, rationale: "Newer assessment." };
    const result = selectCurrentAssessment([
      { marker: encodePriorityMarker(older), authorAssociation: "OWNER", createdAt: "2026-08-10T00:00:00Z", databaseId: 1 },
      { marker: encodePriorityMarker(newest), authorAssociation: "COLLABORATOR", createdAt: "2026-08-10T00:00:00Z", databaseId: 2 },
      { marker: encodePriorityMarker({ ...assessment, rationale: "Untrusted." }), authorAssociation: "NONE", createdAt: "2026-08-11T00:00:00Z", databaseId: 3 },
    ]);

    expect(result?.assessment).toMatchObject({ provider: "anything-opaque", urgency: 5 });
  });

  test("orders assessed work before visible unassessed work and uses age then number as tie breaks", () => {
    const entries = sortQueue([
      { number: 12, createdAt: "2026-08-03T00:00:00Z", labels: [], assessment: null },
      { number: 11, createdAt: "2026-08-02T00:00:00Z", labels: [], assessment: { ...assessment, issue: 11, rationale: "Same score." } },
      { number: 10, createdAt: "2026-08-01T00:00:00Z", labels: [], assessment: { ...assessment, issue: 10, rationale: "Same score." } },
      { number: 9, createdAt: "2026-08-04T00:00:00Z", labels: [], assessment: { ...assessment, issue: 9, effort: 1, rationale: "Highest score." } },
    ]);

    expect(entries.map((entry) => entry.number)).toEqual([9, 10, 11, 12]);
    expect(entries[0]).toMatchObject({ assessed: true, components: { impact: 5, urgency: 4 } });
    expect(entries[3]).toMatchObject({ assessed: false, score: 0 });
  });
});

describe("backlog lifecycle metrics", () => {
  test("uses nearest-rank p90 and average-even median with a deterministic upper bound", () => {
    const result = evaluateMetrics({
      since: "2026-08-01T00:00:00Z",
      now: "2026-08-20T00:00:00Z",
      issues: [
        { number: 1, state: "OPEN", labels: ["WIP"], createdAt: "2026-08-02T00:00:00Z" },
        { number: 2, state: "OPEN", labels: [], createdAt: "2026-08-03T00:00:00Z" },
      ],
      pullRequests: [
        { number: 1, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-08-02T01:00:00Z", gateAt: "2026-08-01T01:00:00Z", state: "CLOSED", labels: [] },
        { number: 2, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-08-02T03:00:00Z", gateAt: "2026-08-01T02:00:00Z" },
        { number: 3, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-08-02T06:00:00Z", gateAt: "2026-08-01T03:00:00Z" },
        { number: 4, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-08-02T10:00:00Z", gateAt: "2026-08-01T04:00:00Z", state: "OPEN", labels: ["merge-ready"] },
      ],
    });

    expect(result.bounds).toEqual({ since: "2026-08-01T00:00:00.000Z", until: "2026-08-20T00:00:00.000Z" });
    expect(result.mergedPullRequests).toBe(4);
    expect(result.gatedPullRequests).toBe(4);
    expect(result.currentWip).toBe(1);
    expect(result.currentMergeReady).toBe(1);
    expect(result.durations.openToGate).toEqual({ sampleSize: 4, median: 9000, p90: 14400 });
    expect(result.durations.gateToMerge).toEqual({ sampleSize: 4, median: 93600, p90: 108000 });
    expect(result.durations.openToMerge).toEqual({ sampleSize: 4, median: 102600, p90: 122400 });
  });

  test("returns null for empty samples and rejects negative chronology instead of clamping it", () => {
    const empty = evaluateMetrics({ since: "2026-08-01T00:00:00Z", now: "2026-08-02T00:00:00Z", issues: [], pullRequests: [] });
    expect(empty.durations.openToGate).toBeNull();
    expect(() => evaluateMetrics({
      since: "2026-08-01T00:00:00Z",
      now: "2026-08-02T00:00:00Z",
      issues: [],
      pullRequests: [{ number: 1, createdAt: "2026-08-01T03:00:00Z", gateAt: "2026-08-01T01:00:00Z", mergedAt: null }],
    })).toThrow("PR #1 has negative open-to-gate duration");
  });

  test("uses event-specific windows and scans current labels independently of since", () => {
    const result = evaluateMetrics({
      since: "2026-08-10T00:00:00Z",
      now: "2026-08-20T00:00:00Z",
      issues: [{ number: 1, state: "OPEN", labels: ["WIP"], createdAt: "2026-08-01T00:00:00Z" }],
      pullRequests: [
        { number: 1, createdAt: "2026-08-01T00:00:00Z", gateAt: "2026-08-09T00:00:00Z", mergedAt: "2026-08-11T00:00:00Z" },
        { number: 2, createdAt: "2026-08-01T00:00:00Z", gateAt: "2026-08-11T00:00:00Z", mergedAt: null, state: "OPEN", labels: ["merge-ready"] },
      ],
    });

    expect(result.mergedPullRequests).toBe(1);
    expect(result.gatedPullRequests).toBe(1);
    expect(result.currentWip).toBe(1);
    expect(result.currentMergeReady).toBe(1);
    expect(result.durations.openToGate?.sampleSize).toBe(1);
    expect(result.durations.gateToMerge?.sampleSize).toBe(1);
    expect(() => evaluateMetrics({ since: "2026-08-21T00:00:00Z", now: "2026-08-20T00:00:00Z", issues: [], pullRequests: [] })).toThrow("since must not be after now");
  });
});

function priorityRunner(respond: (argv: string[]) => unknown): Runner {
  return { async run(argv) { return { exitCode: 0, stderr: "", stdout: JSON.stringify(respond(argv)) }; } };
}

describe("conveyor priority boundaries", () => {
  test("requires an existing open issue before an applied assessment can publish", async () => {
    const calls: string[][] = [];
    const runner: Runner = {
      async run(argv) {
        calls.push(argv);
        if (argv[1] === "repo") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } }) };
        if (argv[1] === "api" && argv[2] === "repos/o/r/issues/1036") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ number: 1036, state: "closed" }) };
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      },
    };

    await expect(prioritize(runner, assessment, true)).resolves.toMatchObject({ violations: ["issue #1036 must be open"] });
    expect(calls.some((argv) => argv.includes("--method"))).toBe(false);
  });

  test("queues all comment pages, ignores untrusted lookalikes, and rejects malformed trusted markers", async () => {
    const older = encodePriorityMarker({ ...assessment, rationale: "Earlier." });
    const newer = encodePriorityMarker({ ...assessment, urgency: 5, rationale: "Newer." });
    const runner = priorityRunner((argv) => {
      if (argv[1] === "repo") return { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } };
      if ((argv[2] ?? "").includes("/issues?state=open")) return [
        { number: 10, state: "OPEN", labels: [], createdAt: "2026-08-02T00:00:00Z" },
        { number: 11, state: "OPEN", labels: [], createdAt: "2026-08-01T00:00:00Z" },
        { number: 12, state: "OPEN", labels: [{ name: "WIP" }], createdAt: "2026-08-01T00:00:00Z" },
        { number: 13, state: "OPEN", labels: [], createdAt: "2026-08-01T00:00:00Z", pull_request: { url: "https://example.test/pr/13" } },
      ];
      const target = argv[2] ?? "";
      if (target.includes("issues/10/comments") && target.endsWith("page=1")) return Array.from({ length: 100 }, (_, index) => ({ id: index + 1, created_at: "2026-08-01T00:00:00Z", author_association: "MEMBER", body: index === 99 ? older : "ordinary" }));
      if (target.includes("issues/10/comments") && target.endsWith("page=2")) return [
        { id: 101, created_at: "2026-08-03T00:00:00Z", author_association: "NONE", body: newer },
        { id: 102, created_at: "2026-08-03T00:00:00Z", author_association: "COLLABORATOR", body: newer },
      ];
      if (target.includes("issues/11/comments")) return [];
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });

    expect(await queue(runner)).toMatchObject({ entries: [{ number: 10, assessed: true, score: 90 }, { number: 11, assessed: false, score: 0 }] });

    const malformed = priorityRunner((argv) => {
      if (argv[1] === "repo") return { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } };
      if ((argv[2] ?? "").includes("/issues?state=open")) return [{ number: 10, state: "OPEN", labels: [], createdAt: "2026-08-02T00:00:00Z" }];
      if ((argv[2] ?? "").includes("comments")) return [{ id: 1, created_at: "2026-08-01T00:00:00Z", author_association: "OWNER", body: "<!-- kesha-backlog-priority:v1 {broken -->" }];
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(queue(malformed)).rejects.toThrow("priority marker is malformed");
  });

  test("aggregates only trusted gate markers and refuses malformed trusted gate state", async () => {
    const gate = "<!-- kesha-backlog-gate:v1 {\"version\":1,\"issue\":1,\"pr\":2,\"evidence\":{\"version\":1,\"provider\":\"opaque\",\"verdict\":\"APPROVED\",\"headSha\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"uri\":\"https://example.test\",\"digest\":\"not-a-real-digest\"}} -->";
    const runner = priorityRunner((argv) => {
      if (argv[1] === "repo") return { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } };
      if ((argv[2] ?? "").includes("/issues?state=all")) return [];
      if ((argv[2] ?? "").includes("/pulls?state=all")) return [{ number: 2, created_at: "2026-08-01T00:00:00Z", merged_at: null, state: "OPEN", labels: [], head: { sha: "a".repeat(40) } }];
      if (argv[2] === "graphql") return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } } };
      if ((argv[2] ?? "").includes("comments")) return [{ id: 1, created_at: "2026-08-02T00:00:00Z", author_association: "OWNER", body: gate }];
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });

    await expect(metrics(runner, "2026-08-01T00:00:00Z", new Date("2026-08-03T00:00:00Z"))).rejects.toThrow("trusted gate marker is malformed");
  });
});
