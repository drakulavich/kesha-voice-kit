import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  encodeGateMarker,
  evaluateClose,
  evaluateGate,
  evaluateSync,
  issueNumberFromBranch,
  isDirectManagedWorktree,
  loadChecks,
  loadMarker,
  parseGateEvidence,
  parseGateMarker,
  sync,
  type CloseFacts,
  type GateEvidence,
  type GateFacts,
  type Runner,
  type SyncFacts,
} from "../../scripts/backlog-conveyor";

const head = "a".repeat(40);
function evidenceFor(overrides: Partial<Omit<GateEvidence, "digest">> = {}): GateEvidence {
  const payload = {
    version: 1 as const,
    provider: "independent-review-system",
    verdict: "APPROVED" as const,
    headSha: head,
    uri: "https://reviews.example.test/evidence/1",
    ...overrides,
  };
  return { ...payload, digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

const evidence = evidenceFor();

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
    checks: [{ name: "🧪 CI", state: "SUCCESS", appId: null, attemptAt: "2026-08-14T10:00:00Z", id: 1 }],
    evidence,
    marker: null,
    ...overrides,
  };
}

describe("backlog gate", () => {
  test("accepts verified provider evidence without a distinct GitHub approver", () => {
    const facts = gateFacts({
      pullRequest: {
        ...gateFacts().pullRequest,
        reviews: [{ state: "APPROVED", author: "author", commitSha: head, submittedAt: "2026-08-14T10:00:00Z" }],
      },
    });

    expect(evaluateGate(facts).violations).not.toContain("no independent approval is bound to the current head SHA");
  });

  test("rejects a pull request that closes a different issue", () => {
    const facts = gateFacts({
      pullRequest: { ...gateFacts().pullRequest, closingIssueNumbers: [1031] },
    });

    expect(evaluateGate(facts).violations).toContain("closing issues must equal [1032]");
  });

  test("rejects skipped, pending, or absent required checks", () => {
    const facts = gateFacts({ checks: [{ name: "🧪 CI", state: "SKIPPED", appId: null, attemptAt: "2026-08-14T10:00:00Z", id: 1 }] });

    expect(evaluateGate(facts).violations).toContain("required check '🧪 CI' is SKIPPED");
    expect(evaluateGate(gateFacts({ checks: [{ name: "🧪 CI", state: "PENDING", appId: null, attemptAt: "2026-08-14T10:00:00Z", id: 1 }] })).violations).toContain("required check '🧪 CI' is PENDING");
    expect(evaluateGate(gateFacts({ checks: [] })).violations).toContain("required check '🧪 CI' is absent");
  });

  test("accepts arbitrary evidence providers but validates verdict and SHA", () => {
    const secondProvider = evidenceFor({ provider: "any-future-orchestrator" });
    expect(parseGateEvidence(secondProvider)).toEqual(secondProvider);
    expect(() => parseGateEvidence(evidenceFor({ verdict: "PENDING" as "APPROVED" }))).toThrow("verdict must be APPROVED");
    expect(() => parseGateEvidence(evidenceFor({ version: 2 as 1 }))).toThrow("version must equal 1");
    expect(() => parseGateEvidence(evidenceFor({ headSha: "not-a-sha" }))).toThrow("headSha must be a Git SHA");
    expect(() => parseGateEvidence(evidenceFor({ uri: "" }))).toThrow("uri must be a non-empty string");
    expect(() => parseGateEvidence({ ...evidence, digest: "d".repeat(64) })).toThrow("digest does not match canonical evidence payload");
    expect(() => parseGateEvidence({ ...evidence, digest: "not-a-digest" })).toThrow("digest must be a SHA-256 digest");
  });

  test("uses the latest matching check attempt rather than an older failure", () => {
    const facts = gateFacts({
      checks: [
        { name: "🧪 CI", state: "FAILURE", appId: 17, attemptAt: "2026-08-14T10:00:00Z", id: 1 },
        { name: "🧪 CI", state: "SUCCESS", appId: 17, attemptAt: "2026-08-14T11:00:00Z", id: 2 },
      ],
      requiredChecks: [{ context: "🧪 CI", appId: 17 }],
    });

    expect(evaluateGate(facts).violations).not.toContain("required check '🧪 CI' is FAILURE");
  });

  test("uses an attempt start time when an older parallel run finishes later", async () => {
    const runner: Runner = {
      async run(argv) {
        const target = argv[2] ?? "";
        if (target.includes("check-runs")) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              check_runs: [
                { id: 1, name: "🧪 CI", status: "completed", conclusion: "failure", app: { id: 17 }, started_at: "2026-08-14T10:00:00Z", completed_at: "2026-08-14T12:00:00Z" },
                { id: 2, name: "🧪 CI", status: "completed", conclusion: "success", app: { id: 17 }, started_at: "2026-08-14T11:00:00Z", completed_at: "2026-08-14T11:30:00Z" },
              ],
            }),
          };
        }
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ statuses: [] }) };
      },
    };
    const facts = gateFacts({
      checks: await loadChecks(runner, { owner: "o", name: "r" }, head),
      requiredChecks: [{ context: "🧪 CI", appId: 17 }],
    });

    expect(evaluateGate(facts).violations).not.toContain("required check '🧪 CI' is FAILURE");
  });

  test("rejects a matching check name from the wrong protected app", () => {
    const facts = gateFacts({
      checks: [{ name: "🧪 CI", state: "SUCCESS", appId: 99, attemptAt: "2026-08-14T11:00:00Z", id: 2 }],
      requiredChecks: [{ context: "🧪 CI", appId: 17 }],
    });

    expect(evaluateGate(facts).violations).toContain("required check '🧪 CI' for app 17 is absent");
  });

  test("blocks a reviewer who requested changes after approving the current head", () => {
    const facts = gateFacts({
      pullRequest: {
        ...gateFacts().pullRequest,
        reviews: [
          { state: "APPROVED", author: "reviewer", commitSha: head, submittedAt: "2026-08-14T10:00:00Z" },
          { state: "CHANGES_REQUESTED", author: "reviewer", commitSha: head, submittedAt: "2026-08-14T11:00:00Z" },
        ],
      },
    });

    expect(evaluateGate(facts).violations).toContain("an independent reviewer requested changes on the current head");
  });

  test("keeps an approval effective after a later comment", () => {
    const facts = gateFacts({
      pullRequest: {
        ...gateFacts().pullRequest,
        reviews: [
          { state: "APPROVED", author: "reviewer", commitSha: head, submittedAt: "2026-08-14T10:00:00Z" },
          { state: "COMMENTED", author: "reviewer", commitSha: head, submittedAt: "2026-08-14T11:00:00Z" },
        ],
      },
    });

    expect(evaluateGate(facts).violations).not.toContain("no independent approval is bound to the current head SHA");
  });

  test("offers a marker and merge-ready label for a fully valid gate", () => {
    expect(evaluateGate(gateFacts()).safeActions.map((action) => action.kind)).toEqual(["create-marker", "add-merge-ready"]);
  });

  test("reuses a current trusted marker from another evidence provider", () => {
    const otherEvidence = evidenceFor({ provider: "future-orchestrator" });
    const facts = gateFacts({ marker: { version: 1, issue: 1032, pr: 1040, evidence }, evidence: otherEvidence });

    expect(evaluateGate(facts).safeActions.map((action) => action.kind)).toEqual(["add-merge-ready"]);
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
  test("round-trips a verified portable marker", () => {
    const marker = { version: 1 as const, issue: 1032, pr: 1040, evidence };

    expect(parseGateMarker(encodeGateMarker(marker))).toEqual(marker);
  });

  test("ignores untrusted markers and finds the newest trusted marker beyond the first page", async () => {
    const older = encodeGateMarker({ version: 1, issue: 1032, pr: 1040, evidence });
    const newestEvidence = evidenceFor({ provider: "other-reviewer" });
    const newest = encodeGateMarker({ version: 1, issue: 1032, pr: 1040, evidence: newestEvidence });
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ body: index === 99 ? older : "ordinary", author_association: "MEMBER" }));
    const secondPage = [
      { body: newest, author_association: "NONE" },
      { body: newest, author_association: "COLLABORATOR" },
    ];

    await expect(loadMarker(commentsRunner([firstPage, secondPage]), { owner: "o", name: "r" }, 1040)).resolves.toEqual({
      version: 1,
      issue: 1032,
      pr: 1040,
      evidence: newestEvidence,
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
          gateVerified: false,
        },
      ],
      worktrees: [],
    };

    expect(evaluateSync(facts).safeActions).toEqual([{ kind: "remove-merge-ready", pr: 1040 }]);
  });

  test("does not remove WIP from an open issue after a closed unmerged PR", () => {
    const result = evaluateSync({
      issues: [{ number: 1032, state: "OPEN", labels: ["WIP"] }],
      pullRequests: [{ number: 1040, state: "CLOSED", headSha: head, labels: [], closingIssueNumbers: [1032], marker: null, gateVerified: false }],
      worktrees: [],
    });

    expect(result.findings).toContain("issue #1032 retains WIP after PR #1040 closed; automatic cleanup requires a closed issue");
    expect(result.safeActions).toEqual([]);
  });

  test("deduplicates WIP repair when more than one old PR references a closed issue", () => {
    const result = evaluateSync({
      issues: [{ number: 1032, state: "CLOSED", labels: ["WIP"] }],
      pullRequests: [
        { number: 1040, state: "MERGED", headSha: head, labels: [], closingIssueNumbers: [1032], marker: null, gateVerified: false },
        { number: 1041, state: "CLOSED", headSha: head, labels: [], closingIssueNumbers: [1032], marker: null, gateVerified: false },
      ],
      worktrees: [],
    });

    expect(result.safeActions).toEqual([{ kind: "remove-wip", issue: 1032 }]);
  });

  test("preserves merge-ready when current trusted evidence has green facts but no distinct GitHub approver", async () => {
    const marker = encodeGateMarker({ version: 1, issue: 1032, pr: 1040, evidence });
    const runner: Runner = {
      async run(argv) {
        if (argv[0] === "git" && argv[1] === "rev-parse") return { exitCode: 0, stdout: "/repo/.git\n", stderr: "" };
        if (argv[0] === "git" && argv[1] === "worktree") return { exitCode: 0, stdout: "worktree /repo\nHEAD deadbeef\nbare\n", stderr: "" };
        if (argv[0] === "gh" && argv[1] === "repo") return { exitCode: 0, stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } }), stderr: "" };
        if (argv[0] === "gh" && argv[1] === "issue") return { exitCode: 0, stdout: JSON.stringify([{ number: 1032, state: "OPEN", labels: [] }]), stderr: "" };
        if (argv[0] === "gh" && argv[1] === "pr") return { exitCode: 0, stdout: JSON.stringify([{ number: 1040, state: "OPEN", mergedAt: null, headRefOid: head, labels: [{ name: "merge-ready" }], closingIssuesReferences: [{ number: 1032 }] }]), stderr: "" };
        if (argv[0] === "gh" && argv[1] === "api" && argv[2] === "graphql") {
          return { exitCode: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { pullRequest: { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", headRefOid: head, baseRefName: "main", author: { login: "author" }, labels: { nodes: [{ name: "merge-ready" }] }, closingIssuesReferences: { nodes: [{ number: 1032 }] }, reviews: { nodes: [] } } } } }) };
        }
        const target = argv[2] ?? "";
        if (target.includes("comments")) return { exitCode: 0, stdout: JSON.stringify([{ body: marker, author_association: "OWNER" }]), stderr: "" };
        if (target.includes("required_status_checks")) return { exitCode: 0, stdout: JSON.stringify({ contexts: ["🧪 CI"], checks: [] }), stderr: "" };
        if (target.includes("check-runs")) return { exitCode: 0, stdout: JSON.stringify({ check_runs: [{ id: 1, name: "🧪 CI", status: "completed", conclusion: "success", app: { id: 1 }, started_at: "2026-08-14T10:00:00Z", completed_at: "2026-08-14T10:01:00Z" }] }), stderr: "" };
        if (target.endsWith("/status")) return { exitCode: 0, stdout: JSON.stringify({ statuses: [] }), stderr: "" };
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      },
    };

    expect((await sync(runner, false)).safeActions).toEqual([]);
  });

  test("aborts before mutation when current check facts cannot be loaded", async () => {
    const calls: string[][] = [];
    const marker = encodeGateMarker({ version: 1, issue: 1032, pr: 1040, evidence });
    const runner: Runner = {
      async run(argv) {
        calls.push(argv);
        if (argv[0] === "git" && argv[1] === "rev-parse") return { exitCode: 0, stdout: "/repo/.git\n", stderr: "" };
        if (argv[0] === "git" && argv[1] === "worktree") return { exitCode: 0, stdout: "worktree /repo\nHEAD deadbeef\nbare\n", stderr: "" };
        if (argv[0] === "gh" && argv[1] === "repo") return { exitCode: 0, stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } }), stderr: "" };
        if (argv[0] === "gh" && argv[1] === "issue") return { exitCode: 0, stdout: JSON.stringify([{ number: 1032, state: "OPEN", labels: [] }]), stderr: "" };
        if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") return { exitCode: 0, stdout: JSON.stringify([{ number: 1040, state: "OPEN", mergedAt: null, headRefOid: head, labels: [{ name: "merge-ready" }], closingIssuesReferences: [{ number: 1032 }] }]), stderr: "" };
        if (argv[0] === "gh" && argv[1] === "api" && argv[2] === "graphql") {
          return { exitCode: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { pullRequest: { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", headRefOid: head, baseRefName: "main", author: { login: "author" }, labels: { nodes: [{ name: "merge-ready" }] }, closingIssuesReferences: { nodes: [{ number: 1032 }] }, reviews: { nodes: [{ state: "APPROVED", submittedAt: "2026-08-14T10:00:00Z", author: { login: "reviewer" }, commit: { oid: head } }] } } } } }) };
        }
        const target = argv[2] ?? "";
        if (target.includes("comments")) return { exitCode: 0, stdout: JSON.stringify([{ body: marker, author_association: "MEMBER" }]), stderr: "" };
        if (target.includes("required_status_checks")) return { exitCode: 0, stdout: JSON.stringify({ contexts: ["🧪 CI"], checks: [] }), stderr: "" };
        if (target.includes("check-runs")) return { exitCode: 1, stdout: "", stderr: "rate limited" };
        if (target.endsWith("/status")) return { exitCode: 0, stdout: JSON.stringify({ statuses: [] }), stderr: "" };
        if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "edit") return { exitCode: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      },
    };

    await expect(sync(runner, true)).rejects.toThrow("gh api check runs failed (1): rate limited");
    expect(calls.some((argv) => argv[0] === "gh" && argv[1] === "pr" && argv[2] === "edit")).toBe(false);
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

  test("accepts only a real direct child of .worktrees", () => {
    const root = mkdtempSync(join(tmpdir(), "kesha-conveyor-worktree-"));
    const managed = join(root, ".worktrees");
    const direct = join(managed, "issue-1032");
    const nested = join(direct, "nested");
    const linked = join(managed, "linked-issue-1032");
    try {
      mkdirSync(nested, { recursive: true });
      symlinkSync(direct, linked, "dir");

      expect(isDirectManagedWorktree(direct, managed)).toBe(true);
      expect(isDirectManagedWorktree(nested, managed)).toBe(false);
      expect(isDirectManagedWorktree(linked, managed)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(evaluateClose(facts).safeActions).toEqual([]);
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

  test("refuses an outside worktree without offering WIP cleanup", () => {
    const facts: CloseFacts = {
      issue: { number: 1032, state: "CLOSED", labels: ["WIP"] },
      pullRequest: { number: 1040, state: "MERGED", closingIssueNumbers: [1032] },
      worktree: { path: "/elsewhere/issue-1032", branch: "chore/issue-1032", dirty: false, insideManagedDirectory: false },
    };

    expect(evaluateClose(facts).refusals).toContain("matching worktree is outside the managed .worktrees directory");
    expect(evaluateClose(facts).safeActions).toEqual([]);
  });
});
