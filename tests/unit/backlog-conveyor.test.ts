import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  acquireLease,
  claim,
  encodeClaimMarker,
  evaluateLeaseOperation,
  evaluateCollisionPlan,
  leaseDirectory,
  leaseRoot,
  loadClaims,
  loadCollisionWorktrees,
  loadPullRequestFiles,
  parseClaimManifest,
  releaseLease,
  statusLease,
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
  test("rejects approval evidence bound to a previous head", () => {
    const facts = gateFacts({ evidence: evidenceFor({ headSha: "b".repeat(40) }) });

    expect(evaluateGate(facts).violations).toContain("review evidence is not bound to the current head SHA");
  });

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

  test("loads all check-run attempts so a second-page success supersedes an older failure", async () => {
    const checkRunTargets: string[] = [];
    const olderFailure = { id: 1, name: "🧪 CI", status: "completed", conclusion: "failure", app: { id: 17 }, started_at: "2026-08-14T10:00:00Z", completed_at: "2026-08-14T10:01:00Z" };
    const filler = Array.from({ length: 99 }, (_, index) => ({ id: index + 10, name: `other-${index}`, status: "completed", conclusion: "success", app: { id: 17 }, started_at: "2026-08-14T10:00:00Z", completed_at: "2026-08-14T10:01:00Z" }));
    const newerSuccess = { id: 2, name: "🧪 CI", status: "completed", conclusion: "success", app: { id: 17 }, started_at: "2026-08-14T11:00:00Z", completed_at: "2026-08-14T11:01:00Z" };
    const runner: Runner = {
      async run(argv) {
        const target = argv[2] ?? "";
        if (target.includes("check-runs")) {
          checkRunTargets.push(target);
          const page = new URL(`https://example.test/${target}`).searchParams.get("page");
          return { exitCode: 0, stderr: "", stdout: JSON.stringify({ check_runs: page === "2" ? [newerSuccess] : [olderFailure, ...filler] }) };
        }
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ statuses: [] }) };
      },
    };

    const facts = gateFacts({ checks: await loadChecks(runner, { owner: "o", name: "r" }, head), requiredChecks: [{ context: "🧪 CI", appId: 17 }] });

    expect(checkRunTargets).toEqual([
      `repos/o/r/commits/${head}/check-runs?filter=all&per_page=100&page=1`,
      `repos/o/r/commits/${head}/check-runs?filter=all&per_page=100&page=2`,
    ]);
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

const coordinationNow = new Date("2026-08-15T12:00:00.000Z");

function manifest(overrides: Record<string, unknown> = {}) {
  return parseClaimManifest({
    version: 1,
    issue: 1034,
    holder: "lane-a",
    paths: ["scripts/backlog.ts"],
    ttlSeconds: 600,
    ...overrides,
  });
}

function claimRecord(issue: number, holder: string, paths: string[], createdAt: string, id: number, expiresAt = "2026-08-15T12:10:00.000Z") {
  return {
    issue,
    state: "OPEN",
    labels: ["WIP"],
    authorAssociation: "MEMBER",
    createdAt,
    id,
    marker: {
      version: 1 as const,
      action: "claim" as const,
      manifest: { version: 1 as const, issue, holder, paths, ttlSeconds: 600 },
      expiresAt,
    },
  };
}

describe("backlog collision coordination", () => {
  test("plans claim, pull-request, and worktree collisions without crossing prefix boundaries", () => {
    const result = evaluateCollisionPlan(manifest({ paths: ["scripts"] }), {
      claims: [claimRecord(1033, "lane-b", ["scripts/backlog-conveyor.ts"], "2026-08-15T11:00:00.000Z", 1)],
      pullRequests: [{ number: 1041, closingIssueNumbers: [1033], files: ["scripts/backlog.ts"] }],
      worktrees: [{ branch: "feat/issue-1033", files: ["scripts/backlog.ts"] }],
    }, coordinationNow);

    expect(result.edges.map((edge) => edge.source)).toEqual(["claim", "pull-request", "worktree"]);
    expect(evaluateCollisionPlan(manifest(), {
      claims: [claimRecord(1033, "lane-b", ["scripts/backlog.tsx"], "2026-08-15T11:00:00.000Z", 1)],
      pullRequests: [],
      worktrees: [],
    }, coordinationNow).edges).toEqual([]);
  });

  test("excludes the candidate issue's own claim, pull request, and worktree from blocking", () => {
    const result = evaluateCollisionPlan(manifest(), {
      claims: [claimRecord(1034, "lane-a", ["scripts/backlog.ts"], "2026-08-15T11:00:00.000Z", 1)],
      pullRequests: [{ number: 1042, closingIssueNumbers: [1034], files: ["scripts/backlog.ts"] }],
      worktrees: [{ branch: "feat/issue-1034", files: ["scripts/backlog.ts"] }],
    }, coordinationNow);

    expect(result.edges).toEqual([]);
    expect(result.self.map((entry) => entry.source)).toEqual(["claim", "pull-request", "worktree"]);
  });

  test("treats expired claims as inactive and preserves a live canonical manifest as idempotent", () => {
    const expired = claimRecord(1033, "lane-b", ["scripts/backlog.ts"], "2026-08-15T10:00:00.000Z", 1, "2026-08-15T11:00:00.000Z");
    const liveSelf = claimRecord(1034, "lane-a", ["scripts/backlog.ts"], "2026-08-15T11:59:00.000Z", 2);
    const result = evaluateCollisionPlan(manifest(), { claims: [expired, liveSelf], pullRequests: [], worktrees: [] }, coordinationNow);

    expect(result.edges).toEqual([]);
    expect(result.idempotent).toBe(true);
    expect(result.expiresAt).toBe("2026-08-15T12:10:00.000Z");
  });

  test("uses an ordered accepted-claim sweep so a loser cannot create a phantom lock", () => {
    const result = evaluateCollisionPlan(manifest({ paths: ["z"] }), {
      claims: [
        claimRecord(1031, "lane-a", ["x", "y"], "2026-08-15T11:00:00.000Z", 1),
        claimRecord(1032, "lane-b", ["y", "z"], "2026-08-15T11:01:00.000Z", 2),
      ],
      pullRequests: [],
      worktrees: [],
    }, coordinationNow);

    expect(result.edges).toEqual([]);
    expect(result.rejectedClaimIds).toEqual([2]);
  });

  test("uses database id as the tie-breaker for concurrent opaque holders sharing one login", () => {
    const result = evaluateCollisionPlan(manifest({ holder: "lane-c" }), {
      claims: [
        claimRecord(1031, "lane-a", ["scripts/backlog.ts"], "2026-08-15T11:00:00.000Z", 9),
        claimRecord(1032, "lane-b", ["scripts/backlog.ts"], "2026-08-15T11:00:00.000Z", 10),
      ],
      pullRequests: [],
      worktrees: [],
    }, coordinationNow);

    expect(result.edges).toEqual([{ source: "claim", issue: 1031, path: "scripts/backlog.ts" }]);
  });

  test("paginates trusted claim markers and ignores external comments", async () => {
    const trusted = encodeClaimMarker(claimRecord(1033, "lane-b", ["scripts/backlog.ts"], "2026-08-15T11:00:00.000Z", 101).marker);
    const external = encodeClaimMarker(claimRecord(1032, "lane-c", ["scripts/backlog.ts"], "2026-08-15T11:01:00.000Z", 102).marker);
    const runner: Runner = {
      async run(argv) {
        const target = argv[2] ?? "";
        const page = Number(new URL(`https://example.test/${target}`).searchParams.get("page") ?? "1");
        if (page === 1) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              created_at: "2026-08-15T10:00:00.000Z",
              body: index === 99 ? external : "ordinary",
              author_association: "NONE",
            }))),
          };
        }
        return { exitCode: 0, stderr: "", stdout: JSON.stringify([{ id: 101, created_at: "2026-08-15T11:00:00.000Z", body: trusted, author_association: "COLLABORATOR" }]) };
      },
    };

    await expect(loadClaims(runner, { owner: "o", name: "r" }, [{ number: 1032, state: "OPEN", labels: ["WIP"] }, { number: 1033, state: "OPEN", labels: ["WIP"] }], coordinationNow)).resolves.toEqual([
      expect.objectContaining({ issue: 1033, id: 101, marker: expect.objectContaining({ action: "claim" }) }),
    ]);
  });

  test("treats a trusted release marker as idempotent and leaves non-WIP issues inactive", async () => {
    const original = claimRecord(1033, "lane-b", ["scripts/backlog.ts"], "2026-08-15T11:00:00.000Z", 101).marker;
    const released = { ...original, action: "release" as const, expiresAt: null };
    const runner: Runner = {
      async run(argv) {
        const target = argv[2] ?? "";
        const issue = target.includes("/1033/") ? 1033 : 1032;
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify([
            { id: 101, created_at: "2026-08-15T11:00:00.000Z", body: encodeClaimMarker(original), author_association: "MEMBER" },
            { id: 102, created_at: "2026-08-15T11:01:00.000Z", body: encodeClaimMarker(released), author_association: "MEMBER" },
          ]),
        };
      },
    };

    await expect(loadClaims(runner, { owner: "o", name: "r" }, [{ number: 1032, state: "OPEN", labels: [] }, { number: 1033, state: "OPEN", labels: ["WIP"] }], coordinationNow)).resolves.toEqual([]);
  });

  test("paginates every open pull request file list", async () => {
    const runner: Runner = {
      async run(argv) {
        const target = argv[2] ?? "";
        const page = Number(new URL(`https://example.test/${target}`).searchParams.get("page") ?? "1");
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(page === 1 ? Array.from({ length: 100 }, (_, index) => ({ filename: `docs/${index}.md` })) : [{ filename: "scripts/backlog.ts" }]) };
      },
    };

    await expect(loadPullRequestFiles(runner, { owner: "o", name: "r" }, 1040)).resolves.toEqual(expect.arrayContaining(["docs/0.md", "scripts/backlog.ts"]));
  });

  test("includes committed worktree changes that are not yet in an open pull request", async () => {
    const runner: Runner = {
      async run(argv) {
        if (argv[0] === "git" && argv[1] === "worktree") return { exitCode: 0, stderr: "", stdout: "worktree /repo/.worktrees/issue-1033\nHEAD deadbeef\nbranch refs/heads/feat/issue-1033\n" };
        if (argv.includes("diff")) return { exitCode: 0, stderr: "", stdout: "scripts/backlog.ts\n" };
        if (argv.includes("status")) return { exitCode: 0, stderr: "", stdout: "" };
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      },
    };

    await expect(loadCollisionWorktrees(runner)).resolves.toEqual([{ branch: "feat/issue-1033", files: ["scripts/backlog.ts"] }]);
  });

  test("re-reads after apply and reports a concurrent winning marker instead of acquired", async () => {
    const calls: string[][] = [];
    let issueReads = 0;
    const theirs = claimRecord(1033, "lane-b", ["scripts/backlog.ts"], "2026-08-15T11:00:00.000Z", 1).marker;
    const runner: Runner = {
      async run(argv) {
        calls.push(argv);
        if (argv[0] === "gh" && argv[1] === "repo") return { exitCode: 0, stderr: "", stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } }) };
        if (argv[0] === "gh" && argv[1] === "issue") {
          issueReads += 1;
          return { exitCode: 0, stderr: "", stdout: JSON.stringify([{ number: 1033, state: "OPEN", labels: [{ name: "WIP" }] }, { number: 1034, state: "OPEN", labels: [{ name: "WIP" }] }]) };
        }
        if (argv[0] === "gh" && argv[1] === "pr") return { exitCode: 0, stderr: "", stdout: "[]" };
        if (argv[0] === "git" && argv[1] === "worktree") return { exitCode: 0, stderr: "", stdout: "worktree /repo\nHEAD deadbeef\nbare\n" };
        if (argv[0] === "gh" && argv[1] === "api" && argv[3] === "--method") return { exitCode: 0, stderr: "", stdout: "{}" };
        const target = argv[2] ?? "";
        if (target.includes("/comments")) return { exitCode: 0, stderr: "", stdout: JSON.stringify(issueReads > 1 && target.includes("/1033/") ? [{ id: 1, created_at: "2026-08-15T11:00:00.000Z", body: encodeClaimMarker(theirs), author_association: "MEMBER" }] : []) };
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      },
    };

    const result = await claim(runner, manifest(), true, coordinationNow);
    expect(result.violations).toContain("claim lost deterministic collision arbitration");
    expect(calls.filter((argv) => argv[0] === "gh" && argv[1] === "issue").length).toBe(2);
  });
});

describe("backlog resource leases", () => {
  async function withLeaseRoot(run: (common: string) => void | Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "kesha-conveyor-lease-"));
    const common = join(root, "shared.git");
    try {
      mkdirSync(common);
      await run(common);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("gives simultaneous contenders one atomic winner visible through the shared git directory", () => withLeaseRoot((common) => {
    const root = leaseDirectory(common);
    const first = acquireLease(root, { resource: "preflight", holder: "lane-a", ttlSeconds: 60 }, coordinationNow);
    const second = acquireLease(leaseDirectory(common), { resource: "preflight", holder: "lane-b", ttlSeconds: 60 }, coordinationNow);

    expect([first.state, second.state].sort()).toEqual(["acquired", "refused"]);
    expect(statusLease(leaseDirectory(common), "preflight", coordinationNow)).toEqual(expect.objectContaining({ state: "held", lease: expect.objectContaining({ holder: "lane-a" }) }));
  }));

  test("refuses a foreign live lease, recovers an expired lease, and makes release idempotent", () => withLeaseRoot((common) => {
    const root = leaseDirectory(common);
    expect(acquireLease(root, { resource: "preflight", holder: "lane-a", ttlSeconds: 60 }, coordinationNow).state).toBe("acquired");
    const firstExpiry = statusLease(root, "preflight", coordinationNow).lease?.expiresAt;
    expect(acquireLease(root, { resource: "preflight", holder: "lane-a", ttlSeconds: 600 }, coordinationNow)).toEqual(expect.objectContaining({ state: "already-owned", lease: expect.objectContaining({ expiresAt: firstExpiry }) }));
    expect(acquireLease(root, { resource: "preflight", holder: "lane-b", ttlSeconds: 60 }, coordinationNow).state).toBe("refused");
    expect(acquireLease(root, { resource: "preflight", holder: "lane-b", ttlSeconds: 60 }, new Date("2026-08-15T12:02:00.000Z"))).toEqual(expect.objectContaining({ state: "acquired", recovered: true }));
    expect(releaseLease(root, { resource: "preflight", holder: "lane-a" }, new Date("2026-08-15T12:02:01.000Z")).state).toBe("refused");
    expect(releaseLease(root, { resource: "preflight", holder: "lane-b" }, new Date("2026-08-15T12:02:01.000Z")).state).toBe("released");
    expect(releaseLease(root, { resource: "preflight", holder: "lane-b" }, new Date("2026-08-15T12:02:01.000Z")).state).toBe("absent");
  }));

  test("fails closed for malformed, symlinked, and path-escaping lease state", () => withLeaseRoot((common) => {
    const root = leaseDirectory(common);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "preflight.json"), "not-json");
    expect(() => statusLease(root, "preflight", coordinationNow)).toThrow("malformed lease state");
    rmSync(join(root, "preflight.json"));
    writeFileSync(join(common, "outside.json"), "{}");
    symlinkSync(join(common, "outside.json"), join(root, "preflight.json"));
    expect(() => acquireLease(root, { resource: "preflight", holder: "lane-a", ttlSeconds: 60 }, coordinationNow)).toThrow("symlink");
    expect(() => acquireLease(root, { resource: "../escape", holder: "lane-a", ttlSeconds: 60 }, coordinationNow)).toThrow("resource");
    rmSync(join(root, "preflight.json"));
    const symlinkedRoot = join(common, "symlinked-root");
    symlinkSync(root, symlinkedRoot, "dir");
    expect(() => statusLease(symlinkedRoot, "preflight", coordinationNow)).toThrow("lease root must not be a symlink");
  }));

  test("keeps status read-only when the lease root is absent", () => withLeaseRoot((common) => {
    const root = leaseDirectory(common);
    expect(statusLease(root, "preflight", coordinationNow)).toEqual({ state: "absent", lease: null });
    expect(existsSync(root)).toBe(false);
  }));

  test("gives dry-run lease commands the same holder-aware refusal and action decision as apply", () => {
    const lease = { version: 1 as const, resource: "preflight", holder: "lane-a", acquiredAt: "2026-08-15T12:00:00.000Z", expiresAt: "2026-08-15T12:01:00.000Z", host: "host", pid: 1 };

    expect(evaluateLeaseOperation("acquire", { resource: "preflight", holder: "lane-b" }, { state: "held", lease })).toMatchObject({ refusals: ["resource lease is held by another holder"], safeActions: [] });
    expect(evaluateLeaseOperation("release", { resource: "preflight", holder: "lane-b" }, { state: "held", lease })).toMatchObject({ refusals: ["resource lease is held by another holder"], safeActions: [] });
    expect(evaluateLeaseOperation("acquire", { resource: "preflight", holder: "lane-a" }, { state: "held", lease })).toMatchObject({ findings: ["already-owned"], safeActions: [] });
    expect(evaluateLeaseOperation("acquire", { resource: "preflight", holder: "lane-b" }, { state: "absent", lease: null })).toMatchObject({ safeActions: [{ kind: "acquire-lease", resource: "preflight" }] });
    expect(evaluateLeaseOperation("release", { resource: "preflight", holder: "lane-a" }, { state: "held", lease })).toMatchObject({ safeActions: [{ kind: "release-lease", resource: "preflight" }] });
  });

  test("fails closed instead of reporting a surviving operation guard as free", () => withLeaseRoot((common) => {
    const root = leaseDirectory(common);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".preflight.lock"), JSON.stringify({ version: 1, resource: "preflight" }));
    expect(() => statusLease(root, "preflight", coordinationNow)).toThrow("lease operation is already in progress");
  }));

  test("discovers the same lease root from separate worktree-shaped git results", async () => {
    const root = mkdtempSync(join(tmpdir(), "kesha-conveyor-common-"));
    try {
      const common = join(root, "shared.git");
      mkdirSync(common);
      const runner: Runner = { async run() { return { exitCode: 0, stderr: "", stdout: `${common}\n` }; } };
      await expect(Promise.all([leaseRoot(runner), leaseRoot(runner)])).resolves.toEqual([leaseDirectory(common), leaseDirectory(common)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses exclusive publication so concurrent processes have one lease winner", async () => withLeaseRoot(async (common) => {
    const root = leaseDirectory(common);
    const source = new URL("../../scripts/backlog-conveyor.ts", import.meta.url).pathname;
    const code = `import { acquireLease } from ${JSON.stringify(source)}; console.log(acquireLease(${JSON.stringify(root)}, { resource: \"preflight\", holder: process.argv[1], ttlSeconds: 60 }, new Date(\"2026-08-15T12:00:00.000Z\")).state);`;
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable is unavailable");
    const processes = ["lane-a", "lane-b"].map((holder) => Bun.spawn([bun, "--eval", code, holder], { stdout: "pipe", stderr: "pipe" }));
    const output = await Promise.all(processes.map(async (process) => ({ exitCode: await process.exited, stdout: (await new Response(process.stdout).text()).trim(), stderr: await new Response(process.stderr).text() })));

    expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ exitCode: 0 }), expect.objectContaining({ exitCode: 0 })]));
    expect(output.map((result) => result.stdout).sort()).toEqual(["acquired", "refused"]);
  }));

  test("serializes concurrent expired-lease reclaimers so an early winner cannot be unlinked", async () => withLeaseRoot(async (common) => {
    const root = leaseDirectory(common);
    acquireLease(root, { resource: "preflight", holder: "expired-owner", ttlSeconds: 1 }, new Date("2026-08-15T10:00:00.000Z"));
    const source = new URL("../../scripts/backlog-conveyor.ts", import.meta.url).pathname;
    const code = `import { acquireLease } from ${JSON.stringify(source)}; console.log(acquireLease(${JSON.stringify(root)}, { resource: \"preflight\", holder: process.argv[1], ttlSeconds: 60 }, new Date(\"2026-08-15T12:00:00.000Z\")).state);`;
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable is unavailable");
    const processes = ["lane-a", "lane-b"].map((holder) => Bun.spawn([bun, "--eval", code, holder], { stdout: "pipe", stderr: "pipe" }));
    const output = await Promise.all(processes.map(async (process) => ({ exitCode: await process.exited, stdout: (await new Response(process.stdout).text()).trim() })));

    expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ exitCode: 0, stdout: "acquired" }), expect.objectContaining({ exitCode: 0, stdout: "refused" })]));
    expect(statusLease(root, "preflight", coordinationNow).lease?.holder).toMatch(/lane-[ab]/);
  }));
});
