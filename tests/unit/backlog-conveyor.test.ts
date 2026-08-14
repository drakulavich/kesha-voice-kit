import { describe, expect, test } from "bun:test";
import {
  encodeGateMarker,
  evaluateClose,
  evaluateGate,
  evaluateSync,
  issueNumberFromBranch,
  loadMarker,
  parseGateEvidence,
  type CloseFacts,
  type GateFacts,
  type Runner,
  type SyncFacts,
} from "../../scripts/backlog-conveyor";

const head = "a".repeat(40);
const evidence = {
  version: 1 as const,
  provider: "independent-review-system",
  verdict: "APPROVED" as const,
  headSha: head,
  uri: "https://reviews.example.test/evidence/1",
  digest: "c".repeat(64),
};

function gateFacts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    issue: 1032,
    pr: 1040,
    defaultBranch: "main",
    pullRequest: {
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      headSha: head,
      baseRefName: "main",
      author: "author",
      closingIssueNumbers: [1032],
      labels: [],
      reviews: [{ state: "APPROVED", author: "reviewer", commitSha: head, submittedAt: "2026-08-14T10:00:00Z" }],
    },
    requiredChecks: [{ context: "🧪 CI", appId: null }],
    checks: [{ name: "🧪 CI", state: "SUCCESS", appId: null, observedAt: "2026-08-14T10:00:00Z", id: 1 }],
    evidence,
    marker: null,
    ...overrides,
  };
}

describe("backlog gate", () => {
  test("rejects an approval that was made for a previous head", () => {
    const facts = gateFacts({
      pullRequest: {
        ...gateFacts().pullRequest,
        reviews: [{ state: "APPROVED", author: "reviewer", commitSha: "b".repeat(40), submittedAt: "2026-08-14T10:00:00Z" }],
      },
    });

    expect(evaluateGate(facts).violations).toContain("no independent approval is bound to the current head SHA");
  });

  test("rejects a pull request that closes a different issue", () => {
    const facts = gateFacts({
      pullRequest: { ...gateFacts().pullRequest, closingIssueNumbers: [1031] },
    });

    expect(evaluateGate(facts).violations).toContain("closing issues must equal [1032]");
  });

  test("rejects skipped, pending, or absent required checks", () => {
    const facts = gateFacts({ checks: [{ name: "🧪 CI", state: "SKIPPED", appId: null, observedAt: "2026-08-14T10:00:00Z", id: 1 }] });

    expect(evaluateGate(facts).violations).toContain("required check '🧪 CI' is SKIPPED");
  });

  test("accepts arbitrary evidence providers but validates verdict and SHA", () => {
    expect(parseGateEvidence({ ...evidence, provider: "any-future-orchestrator" })).toEqual({
      ...evidence,
      provider: "any-future-orchestrator",
    });
    expect(() => parseGateEvidence({ ...evidence, verdict: "PENDING" })).toThrow("verdict must be APPROVED");
    expect(() => parseGateEvidence({ ...evidence, version: 2 })).toThrow("version must equal 1");
    expect(() => parseGateEvidence({ ...evidence, headSha: "not-a-sha" })).toThrow("headSha must be a Git SHA");
    expect(() => parseGateEvidence({ ...evidence, uri: "" })).toThrow("uri must be a non-empty string");
    expect(() => parseGateEvidence({ ...evidence, digest: "not-a-digest" })).toThrow("digest must be a SHA-256 digest");
  });

  test("uses the latest matching check attempt rather than an older failure", () => {
    const facts = gateFacts({
      checks: [
        { name: "🧪 CI", state: "FAILURE", appId: 17, observedAt: "2026-08-14T10:00:00Z", id: 1 },
        { name: "🧪 CI", state: "SUCCESS", appId: 17, observedAt: "2026-08-14T11:00:00Z", id: 2 },
      ],
      requiredChecks: [{ context: "🧪 CI", appId: 17 }],
    });

    expect(evaluateGate(facts).violations).not.toContain("required check '🧪 CI' is FAILURE");
  });

  test("rejects a matching check name from the wrong protected app", () => {
    const facts = gateFacts({
      checks: [{ name: "🧪 CI", state: "SUCCESS", appId: 99, observedAt: "2026-08-14T11:00:00Z", id: 2 }],
      requiredChecks: [{ context: "🧪 CI", appId: 17 }],
    });

    expect(evaluateGate(facts).violations).toContain("required check '🧪 CI' for app 17 is absent");
  });
});

function commentsRunner(pages: unknown[][]): Runner {
  return {
    async run(argv) {
      const target = argv[2] ?? "";
      const page = Number(new URL(`https://example.test/${target}`).searchParams.get("page") ?? "1");
      return { exitCode: 0, stdout: JSON.stringify(pages[page - 1] ?? []), stderr: "" };
    },
  };
}

describe("backlog markers", () => {
  test("ignores untrusted markers and finds the newest trusted marker beyond the first page", async () => {
    const older = encodeGateMarker({ version: 1, issue: 1032, pr: 1040, evidence });
    const newest = encodeGateMarker({ version: 1, issue: 1032, pr: 1040, evidence: { ...evidence, digest: "d".repeat(64) } });
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ body: index === 99 ? older : "ordinary", author_association: "MEMBER" }));
    const secondPage = [
      { body: newest, author_association: "NONE" },
      { body: newest, author_association: "COLLABORATOR" },
    ];

    await expect(loadMarker(commentsRunner([firstPage, secondPage]), { owner: "o", name: "r" }, 1040)).resolves.toEqual({
      version: 1,
      issue: 1032,
      pr: 1040,
      evidence: { ...evidence, digest: "d".repeat(64) },
    });
  });
});

describe("backlog sync", () => {
  test("reports a merge-ready label whose marker no longer matches the PR head", () => {
    const facts: SyncFacts = {
      issues: [],
      pullRequests: [
        {
          number: 1040,
          state: "OPEN",
          headSha: head,
          labels: ["merge-ready"],
          closingIssueNumbers: [1032],
          marker: { version: 1, issue: 1032, pr: 1040, evidence: { ...evidence, headSha: "b".repeat(40) } },
        },
      ],
      worktrees: [],
    };

    expect(evaluateSync(facts).safeActions).toEqual([{ kind: "remove-merge-ready", pr: 1040 }]);
  });
});

describe("managed issue branches", () => {
  test("uses one parser for unprefixed and single-prefix issue branches", () => {
    expect(issueNumberFromBranch("issue-1032")).toBe(1032);
    expect(issueNumberFromBranch("chore/issue-1032")).toBe(1032);
    expect(issueNumberFromBranch("refactor/issue-1032")).toBe(1032);
    expect(issueNumberFromBranch("feat/issue-1032")).toBe(1032);
    expect(issueNumberFromBranch("feature/nested/issue-1032")).toBeNull();
  });

  test("reports any single-prefix branch without WIP as orphaned", () => {
    const result = evaluateSync({
      issues: [{ number: 1032, state: "OPEN", labels: [] }],
      pullRequests: [],
      worktrees: [{ path: "/repo/.worktrees/issue-1032", branch: "refactor/issue-1032", dirty: false, insideManagedDirectory: true }],
    });

    expect(result.findings).toContain("worktree /repo/.worktrees/issue-1032 is orphaned");
  });
});

describe("backlog close", () => {
  test("refuses to remove a dirty matching worktree", () => {
    const facts: CloseFacts = {
      issue: { number: 1032, state: "CLOSED", labels: ["WIP"] },
      pullRequest: { number: 1040, state: "MERGED", closingIssueNumbers: [1032] },
      worktree: { path: "/repo/.worktrees/issue-1032", branch: "feat/issue-1032", dirty: true, insideManagedDirectory: true },
    };

    expect(evaluateClose(facts).refusals).toContain("matching worktree is dirty");
  });

  test("is idempotent after the issue and worktree are already cleaned", () => {
    const facts: CloseFacts = {
      issue: { number: 1032, state: "CLOSED", labels: [] },
      pullRequest: { number: 1040, state: "MERGED", closingIssueNumbers: [1032] },
      worktree: null,
    };

    const result = evaluateClose(facts);
    expect(result.violations).toEqual([]);
    expect(result.refusals).toEqual([]);
    expect(result.safeActions).toEqual([]);
  });
});
