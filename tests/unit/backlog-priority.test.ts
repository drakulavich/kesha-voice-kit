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
        { number: 2, state: "OPEN", labels: ["merge-ready"], createdAt: "2026-08-03T00:00:00Z" },
      ],
      pullRequests: [
        { number: 1, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-08-02T01:00:00Z", gateAt: "2026-08-01T01:00:00Z" },
        { number: 2, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-08-02T03:00:00Z", gateAt: "2026-08-01T02:00:00Z" },
        { number: 3, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-08-02T06:00:00Z", gateAt: "2026-08-01T03:00:00Z" },
        { number: 4, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-08-02T10:00:00Z", gateAt: "2026-08-01T04:00:00Z" },
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
      issues: [{ number: 1, state: "OPEN", labels: ["WIP", "merge-ready"], createdAt: "2026-08-01T00:00:00Z" }],
      pullRequests: [
        { number: 1, createdAt: "2026-08-01T00:00:00Z", gateAt: "2026-08-09T00:00:00Z", mergedAt: "2026-08-11T00:00:00Z" },
        { number: 2, createdAt: "2026-08-01T00:00:00Z", gateAt: "2026-08-11T00:00:00Z", mergedAt: null },
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
