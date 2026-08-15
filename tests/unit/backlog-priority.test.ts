import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  computePriorityScore,
  encodePriorityMarker,
  evaluateMetrics,
  parsePriorityManifest,
  selectCurrentAssessment,
  sortQueue,
  type PriorityAssessment,
} from "../../scripts/backlog-priority";
import { encodeGateMarker, mapBounded, metrics, prioritize, queue, type Runner } from "../../scripts/backlog-conveyor";

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
    expect(() => parsePriorityManifest({ ...assessment, provider: "   " })).toThrow("provider must not have surrounding whitespace");
    expect(() => parsePriorityManifest({ ...assessment, rationale: "   " })).toThrow("rationale must not have surrounding whitespace");
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

  test("orders offsets by instant and refuses a trusted marker on the wrong issue", () => {
    const earlierInstant = { ...assessment, rationale: "Earlier instant." };
    const laterInstant = { ...assessment, urgency: 5, rationale: "Later instant." };
    const selected = selectCurrentAssessment([
      { marker: encodePriorityMarker(earlierInstant), authorAssociation: "OWNER", createdAt: "2026-08-01T01:00:00+02:00", databaseId: 1 },
      { marker: encodePriorityMarker(laterInstant), authorAssociation: "OWNER", createdAt: "2026-08-01T00:30:00Z", databaseId: 2 },
    ], 1036);
    expect(selected?.assessment.rationale).toBe("Later instant.");
    expect(() => selectCurrentAssessment([{ marker: encodePriorityMarker({ ...assessment, issue: 1037 }), authorAssociation: "OWNER", createdAt: "2026-08-01T00:00:00Z", databaseId: 1 }], 1036)).toThrow("does not match comment container");
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

function gateMarker(issue: number, pr: number, headSha: string): string {
  const evidence = { version: 1 as const, provider: "opaque", verdict: "APPROVED" as const, headSha, uri: "https://example.test/gate" };
  return encodeGateMarker({ version: 1, issue, pr, evidence: { ...evidence, digest: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") } });
}

describe("conveyor priority boundaries", () => {
  test("bounds Phase 3 GitHub work without changing input order", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapBounded([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });
    expect(peak).toBe(2);
    expect(result).toEqual([2, 4, 6, 8, 10, 12]);
  });
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
    const older = encodePriorityMarker({ ...assessment, issue: 10, rationale: "Earlier." });
    const newer = encodePriorityMarker({ ...assessment, issue: 10, urgency: 5, rationale: "Newer." });
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

  test("uses a REST second pull page and only the latest valid gate marker for each PR", async () => {
    const head = "a".repeat(40);
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, created_at: "2026-08-01T00:00:00Z", merged_at: null, state: "CLOSED", labels: [], head: { sha: head } }));
    const runner = priorityRunner((argv) => {
      if (argv[1] === "repo") return { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } };
      const target = argv[2] ?? "";
      if (target.includes("/issues?state=all")) return [];
      if (target.includes("/pulls?state=all") && target.endsWith("page=1")) return firstPage;
      if (target.includes("/pulls?state=all") && target.endsWith("page=2")) return [{ number: 101, created_at: "2026-08-01T00:00:00Z", merged_at: "2026-08-02T00:00:00Z", state: "CLOSED", labels: [], head: { sha: head } }];
      if (target === "graphql") {
        const number = Number(argv.find((value) => value.startsWith("number="))?.slice("number=".length));
        return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: number === 101 ? 500 : number }], pageInfo: { hasNextPage: false } } } } } };
      }
      if (target.includes("comments")) {
        const pr = Number(/issues\/(\d+)\/comments/.exec(target)?.[1]);
        if (pr === 101) return [
          { id: 1, created_at: "2026-08-01T01:00:00Z", author_association: "OWNER", body: gateMarker(500, 101, "b".repeat(40)) },
          { id: 2, created_at: "2026-08-01T02:00:00Z", author_association: "OWNER", body: gateMarker(999, 102, head) },
          { id: 3, created_at: "2026-08-01T03:00:00Z", author_association: "OWNER", body: gateMarker(500, 101, head) },
          { id: 4, created_at: "2026-08-01T03:00:00Z", author_association: "COLLABORATOR", body: gateMarker(500, 101, head) },
        ];
        return [];
      }
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });

    const result = await metrics(runner, "2026-08-01T00:00:00Z", new Date("2026-08-03T00:00:00Z"));
    expect(result.mergedPullRequests).toBe(1);
    expect(result.gatedPullRequests).toBe(1);
    expect(result.durations.openToGate).toEqual({ sampleSize: 1, median: 10800, p90: 10800 });
  });

  test("refuses a REST pull pagination cap instead of returning partial metrics", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, created_at: "2026-08-01T00:00:00Z", merged_at: null, state: "OPEN", labels: [], head: { sha: "a".repeat(40) } }));
    const runner = priorityRunner((argv) => {
      if (argv[1] === "repo") return { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } };
      if ((argv[2] ?? "").includes("/issues?state=all")) return [];
      if ((argv[2] ?? "").includes("/pulls?state=all")) return page;
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });

    await expect(metrics(runner, "2026-08-01T00:00:00Z", new Date("2026-08-03T00:00:00Z"))).rejects.toThrow("reached pagination cap");
  });

  test("treats non-sole closing issues as ungated and skips GraphQL without a candidate gate", async () => {
    const head = "a".repeat(40);
    let graphCalls = 0;
    const runner = priorityRunner((argv) => {
      if (argv[1] === "repo") return { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } };
      if ((argv[2] ?? "").includes("/issues?state=all")) return [];
      if ((argv[2] ?? "").includes("/pulls?state=all")) return [
        { number: 1, created_at: "2026-08-01T00:00:00Z", merged_at: null, state: "OPEN", labels: [], head: { sha: head } },
        { number: 2, created_at: "2026-08-01T00:00:00Z", merged_at: null, state: "OPEN", labels: [], head: { sha: head } },
      ];
      if ((argv[2] ?? "").includes("issues/1/comments")) return [];
      if ((argv[2] ?? "").includes("issues/2/comments")) return [{ id: 1, created_at: "2026-08-01T01:00:00Z", author_association: "OWNER", body: gateMarker(20, 2, head) }];
      if (argv[2] === "graphql") {
        graphCalls += 1;
        return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 20 }, { number: 21 }], pageInfo: { hasNextPage: true } } } } } };
      }
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    const result = await metrics(runner, "2026-08-01T00:00:00Z", new Date("2026-08-02T00:00:00Z"));
    expect(result.gatedPullRequests).toBe(0);
    expect(graphCalls).toBe(1);
  });

  test("refuses malformed issue and trusted comment timestamps before queue ordering", async () => {
    const malformedIssue = priorityRunner((argv) => {
      if (argv[1] === "repo") return { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } };
      if ((argv[2] ?? "").includes("/issues?state=open")) return [{ number: 1, state: "OPEN", labels: [], createdAt: "not-a-time" }];
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(queue(malformedIssue)).rejects.toThrow("must be an ISO timestamp");

    const malformedComment = priorityRunner((argv) => {
      if (argv[1] === "repo") return { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } };
      if ((argv[2] ?? "").includes("/issues?state=open")) return [{ number: 1, state: "OPEN", labels: [], createdAt: "2026-08-01T00:00:00Z" }];
      if ((argv[2] ?? "").includes("comments")) return [{ id: 1, created_at: "not-a-time", author_association: "OWNER", body: encodePriorityMarker(assessment) }];
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(queue(malformedComment)).rejects.toThrow("must be an ISO timestamp");
  });

  test("reports a concurrent priority write as superseded when its POST id is no longer current", async () => {
    const marker = encodePriorityMarker({ ...assessment, rationale: "Concurrent update." });
    let reads = 0;
    const runner: Runner = {
      async run(argv) {
        if (argv[1] === "repo") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } }) };
        if (argv[2] === "repos/o/r/issues/1036") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ number: 1036, state: "open" }) };
        if ((argv[2] ?? "").includes("comments") && argv.includes("--method")) return { exitCode: 0, stderr: "", stdout: JSON.stringify({ id: 1 }) };
        if ((argv[2] ?? "").includes("comments")) {
          reads += 1;
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(reads === 1 ? [] : [{ id: 2, created_at: "2026-08-02T00:00:00Z", author_association: "OWNER", body: marker }]) };
        }
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      },
    };

    await expect(prioritize(runner, assessment, true)).resolves.toMatchObject({ accepted: false, violations: ["priority assessment was superseded before confirmation"] });
  });

  test("normalizes lowercase REST pull state for current merge-ready metrics", async () => {
    const runner = priorityRunner((argv) => {
      if (argv[1] === "repo") return { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } };
      if ((argv[2] ?? "").includes("/issues?state=all")) return [];
      if ((argv[2] ?? "").includes("/pulls?state=all")) return [{ number: 1, created_at: "2026-08-01T00:00:00Z", merged_at: null, state: "open", labels: [{ name: "merge-ready" }], head: { sha: "a".repeat(40) } }];
      if (argv[2] === "graphql") return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } } };
      if ((argv[2] ?? "").includes("comments")) return [];
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    expect((await metrics(runner, "2026-08-01T00:00:00Z", new Date("2026-08-02T00:00:00Z"))).currentMergeReady).toBe(1);
  });

  test("retains legacy command flag rejection", () => {
    for (const args of [["sync", "--label", "x"], ["plan", "--manifest", "x", "--limit", "1"], ["lease", "status", "--resource", "preflight", "--since", "2026-08-01T00:00:00Z"]]) {
      const child = Bun.spawnSync(["bun", "scripts/backlog.ts", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode).toBe(3);
    }
  });
});
