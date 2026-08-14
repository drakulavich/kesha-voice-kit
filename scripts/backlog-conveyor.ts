import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const REPORT_SCHEMA_VERSION = 1;

export const ExitCode = {
  success: 0,
  invariantViolation: 2,
  operationalFailure: 3,
  unsafeRefusal: 4,
} as const;

type JsonRecord = Record<string, unknown>;

export interface GateMarker {
  version: 1;
  issue: number;
  pr: number;
  evidence: GateEvidence;
}

export interface GateEvidence {
  version: 1;
  provider: string;
  verdict: "APPROVED";
  headSha: string;
  uri: string;
  digest: string;
}

export interface RequiredCheck {
  context: string;
  appId: number | null;
}

export interface CheckResult {
  name: string;
  state: string;
  appId: number | null;
  attemptAt: string | null;
  id: number;
}

export interface GateFacts {
  issue: number;
  pr: number;
  defaultBranch: string;
  pullRequest: {
    state: string;
    isDraft: boolean;
    mergeable: string;
    headSha: string;
    baseRefName: string;
    author: string;
    closingIssueNumbers: number[];
    labels: string[];
    reviews: Array<{ state: string; author: string | null; commitSha: string | null; submittedAt: string | null }>;
  };
  requiredChecks: RequiredCheck[];
  checks: CheckResult[];
  evidence: GateEvidence;
  marker: GateMarker | null;
}

export interface SyncFacts {
  issues: Array<{ number: number; state: string; labels: string[] }>;
  pullRequests: Array<{
    number: number;
    state: string;
    headSha: string;
    labels: string[];
    closingIssueNumbers: number[];
    marker: GateMarker | null;
  }>;
  worktrees: Array<{ path: string; branch: string | null; dirty: boolean; insideManagedDirectory: boolean }>;
}

export interface CloseFacts {
  issue: { number: number; state: string; labels: string[] };
  pullRequest: { number: number; state: string; closingIssueNumbers: number[] };
  worktree: { path: string; branch: string | null; dirty: boolean; insideManagedDirectory: boolean } | null;
}

export interface Evaluation {
  violations: string[];
  refusals: string[];
  safeActions: Array<{ kind: "add-merge-ready" | "remove-merge-ready" | "remove-wip" | "remove-worktree" | "create-marker"; pr?: number; issue?: number; path?: string; marker?: GateMarker }>;
  findings: string[];
}

export interface RunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(argv: string[]): Promise<RunnerResult>;
}

export class OperationalError extends Error {}

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new OperationalError(`${source} returned invalid JSON`);
  }
}

function requiredRecord(value: unknown, source: string): JsonRecord {
  if (!isRecord(value)) throw new OperationalError(`${source} must be an object`);
  return value;
}

function requiredString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) throw new OperationalError(`${source} must be a non-empty string`);
  return value;
}

function requiredNumber(value: unknown, source: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new OperationalError(`${source} must be an integer`);
  return value;
}

function requiredBoolean(value: unknown, source: string): boolean {
  if (typeof value !== "boolean") throw new OperationalError(`${source} must be a boolean`);
  return value;
}

function requiredArray(value: unknown, source: string): unknown[] {
  if (!Array.isArray(value)) throw new OperationalError(`${source} must be an array`);
  return value;
}

function optionalString(value: unknown, source: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, source);
}

function optionalNumber(value: unknown, source: string): number | null {
  if (value === null || value === undefined) return null;
  return requiredNumber(value, source);
}

async function runJson(runner: Runner, argv: string[], source: string): Promise<unknown> {
  const result = await runner.run(argv);
  if (result.exitCode !== 0) {
    throw new OperationalError(`${source} failed (${result.exitCode}): ${result.stderr.trim() || "no error output"}`);
  }
  return parseJson(result.stdout, source);
}

function labels(value: unknown, source: string): string[] {
  return requiredArray(value, source).map((entry, index) => requiredString(requiredRecord(entry, `${source}[${index}]`).name, `${source}[${index}].name`));
}

function closingIssues(value: unknown, source: string): number[] {
  return requiredArray(value, source).map((entry, index) => requiredNumber(requiredRecord(entry, `${source}[${index}]`).number, `${source}[${index}].number`));
}

export function issueNumberFromBranch(branch: string | null): number | null {
  const match = /^(?:[^/]+\/)?issue-([1-9]\d*)$/.exec(branch ?? "");
  return match ? Number(match[1]) : null;
}

function matchingBranch(branch: string | null, issue: number): boolean {
  return issueNumberFromBranch(branch) === issue;
}

function sameNumbers(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && actual.every((number, index) => number === expected[index]);
}

export function encodeGateMarker(marker: GateMarker): string {
  return `<!-- kesha-backlog-gate:v1 ${JSON.stringify(marker)} -->`;
}

export function parseGateEvidence(value: unknown, source = "gate evidence"): GateEvidence {
  const evidence = requiredRecord(value, source);
  if (evidence.version !== 1) throw new OperationalError(`${source}.version must equal 1`);
  const provider = requiredString(evidence.provider, `${source}.provider`);
  const verdict = requiredString(evidence.verdict, `${source}.verdict`);
  if (verdict !== "APPROVED") throw new OperationalError(`${source}.verdict must be APPROVED`);
  const headSha = requiredString(evidence.headSha, `${source}.headSha`);
  if (!/^[0-9a-f]{40,64}$/i.test(headSha)) throw new OperationalError(`${source}.headSha must be a Git SHA`);
  const uri = requiredString(evidence.uri, `${source}.uri`);
  const digest = requiredString(evidence.digest, `${source}.digest`);
  if (!/^[0-9a-f]{64}$/i.test(digest)) throw new OperationalError(`${source}.digest must be a SHA-256 digest`);
  return { version: 1, provider, verdict: "APPROVED", headSha, uri, digest };
}

export function parseGateMarker(body: string): GateMarker | null {
  const match = /<!-- kesha-backlog-gate:v1 (\{.*\}) -->/.exec(body);
  if (!match?.[1]) return null;
  try {
    const value = requiredRecord(JSON.parse(match[1]), "gate marker");
    if (value.version !== 1) return null;
    return {
      version: 1,
      issue: requiredNumber(value.issue, "gate marker.issue"),
      pr: requiredNumber(value.pr, "gate marker.pr"),
      evidence: parseGateEvidence(value.evidence, "gate marker.evidence"),
    };
  } catch {
    return null;
  }
}

export function evaluateGate(facts: GateFacts): Evaluation {
  const violations: string[] = [];
  const pr = facts.pullRequest;
  if (pr.state !== "OPEN") violations.push("pull request is not open");
  if (pr.isDraft) violations.push("pull request is a draft");
  if (pr.mergeable !== "MERGEABLE") violations.push(`pull request is not mergeable (${pr.mergeable})`);
  if (pr.baseRefName !== facts.defaultBranch) violations.push(`pull request base '${pr.baseRefName}' is not default branch '${facts.defaultBranch}'`);
  if (!sameNumbers(pr.closingIssueNumbers, [facts.issue])) violations.push(`closing issues must equal [${facts.issue}]`);
  if (facts.evidence.headSha !== pr.headSha) violations.push("review evidence is not bound to the current head SHA");
  const approval = pr.reviews.find(
    (review) => review.state === "APPROVED" && review.author !== null && review.author !== pr.author && review.commitSha === pr.headSha && review.submittedAt !== null,
  );
  if (!approval) violations.push("no independent approval is bound to the current head SHA");
  if (facts.requiredChecks.length === 0) violations.push("default branch has no required checks");
  for (const required of facts.requiredChecks) {
    const results = facts.checks.filter((check) => check.name === required.context && (required.appId === null || check.appId === required.appId));
    if (results.length === 0) {
      violations.push(required.appId === null ? `required check '${required.context}' is absent` : `required check '${required.context}' for app ${required.appId} is absent`);
      continue;
    }
    const latest = results.reduce((current, candidate) => {
      const currentTime = current.attemptAt ?? "";
      const candidateTime = candidate.attemptAt ?? "";
      if (candidateTime > currentTime || (candidateTime === currentTime && candidate.id > current.id)) return candidate;
      return current;
    });
    if (latest.state !== "SUCCESS") violations.push(`required check '${required.context}' is ${latest.state}`);
  }
  const marker: GateMarker | null = approval ? { version: 1, issue: facts.issue, pr: facts.pr, evidence: facts.evidence } : null;
  const markerCurrent = facts.marker !== null && facts.marker.issue === facts.issue && facts.marker.pr === facts.pr && JSON.stringify(facts.marker.evidence) === JSON.stringify(facts.evidence);
  const safeActions: Evaluation["safeActions"] = [];
  if (violations.length === 0 && marker && !markerCurrent) safeActions.push({ kind: "create-marker", pr: facts.pr, marker });
  if (violations.length === 0 && !pr.labels.includes("merge-ready")) safeActions.push({ kind: "add-merge-ready", pr: facts.pr });
  return { violations, refusals: [], safeActions, findings: [] };
}

export function evaluateSync(facts: SyncFacts): Evaluation {
  const findings: string[] = [];
  const safeActions: Evaluation["safeActions"] = [];
  for (const pr of facts.pullRequests) {
    if (
      pr.labels.includes("merge-ready") &&
      (!pr.marker || pr.marker.pr !== pr.number || !sameNumbers(pr.closingIssueNumbers, [pr.marker.issue]) || pr.marker.evidence.headSha !== pr.headSha)
    ) {
      findings.push(`PR #${pr.number} has stale merge-ready evidence`);
      safeActions.push({ kind: "remove-merge-ready", pr: pr.number });
    }
    if ((pr.state === "CLOSED" || pr.state === "MERGED") && pr.closingIssueNumbers.length === 1) {
      const issue = facts.issues.find((candidate) => candidate.number === pr.closingIssueNumbers[0]);
      if (issue?.labels.includes("WIP")) {
        findings.push(`issue #${issue.number} retains WIP after PR #${pr.number} ${pr.state.toLowerCase()}`);
        safeActions.push({ kind: "remove-wip", issue: issue.number });
      }
    }
  }
  for (const issue of facts.issues) {
    if (issue.state === "OPEN" && issue.labels.includes("WIP") && !facts.worktrees.some((worktree) => matchingBranch(worktree.branch, issue.number))) {
      findings.push(`issue #${issue.number} is WIP but has no matching worktree`);
    }
  }
  for (const worktree of facts.worktrees) {
    const issue = issueNumberFromBranch(worktree.branch);
    if (worktree.dirty) findings.push(`worktree ${worktree.path} is dirty`);
    if (issue !== null && !facts.issues.some((candidate) => candidate.number === issue && candidate.labels.includes("WIP"))) {
      findings.push(`worktree ${worktree.path} is orphaned`);
    }
  }
  return { violations: [], refusals: [], safeActions, findings };
}

export function evaluateClose(facts: CloseFacts): Evaluation {
  const violations: string[] = [];
  const refusals: string[] = [];
  if (facts.pullRequest.state !== "MERGED" && facts.pullRequest.state !== "CLOSED") violations.push("pull request is neither merged nor closed");
  if (!sameNumbers(facts.pullRequest.closingIssueNumbers, [facts.issue.number])) violations.push(`closing issues must equal [${facts.issue.number}]`);
  if (facts.pullRequest.state === "MERGED" && facts.issue.state !== "CLOSED") violations.push("merged pull request requires a closed issue");
  if (facts.pullRequest.state === "CLOSED" && facts.issue.state !== "OPEN") violations.push("unmerged closed pull request requires an open issue");
  if (facts.worktree?.dirty) refusals.push("matching worktree is dirty");
  if (facts.worktree && !facts.worktree.insideManagedDirectory) refusals.push("matching worktree is outside the managed .worktrees directory");
  const safeActions: Evaluation["safeActions"] = [];
  if (violations.length === 0 && refusals.length === 0 && facts.worktree) safeActions.push({ kind: "remove-worktree", path: facts.worktree.path });
  if (violations.length === 0 && facts.issue.labels.includes("WIP")) safeActions.push({ kind: "remove-wip", issue: facts.issue.number });
  return { violations, refusals, safeActions, findings: [] };
}

export function bunRunner(): Runner {
  return {
    async run(argv) {
      try {
        const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        return { stdout, stderr, exitCode };
      } catch (error) {
        throw new OperationalError(`could not start ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

async function repository(runner: Runner): Promise<{ owner: string; name: string; defaultBranch: string }> {
  const raw = requiredRecord(await runJson(runner, ["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"], "gh repo view"), "gh repo view");
  const [owner, name] = requiredString(raw.nameWithOwner, "gh repo view.nameWithOwner").split("/");
  if (!owner || !name) throw new OperationalError("gh repo view.nameWithOwner must be owner/name");
  const defaultBranch = requiredString(requiredRecord(raw.defaultBranchRef, "gh repo view.defaultBranchRef").name, "gh repo view.defaultBranchRef.name");
  return { owner, name, defaultBranch };
}

const pullRequestQuery = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { number state isDraft mergeable headRefOid baseRefName author { login } labels(first: 100) { nodes { name } } closingIssuesReferences(first: 10) { nodes { number } } reviews(last: 100) { nodes { state submittedAt author { login } commit { oid } } } } } }`;

async function loadPullRequest(runner: Runner, repo: { owner: string; name: string }, number: number): Promise<GateFacts["pullRequest"]> {
  const raw = requiredRecord(await runJson(runner, ["gh", "api", "graphql", "-f", `query=${pullRequestQuery}`, "-F", `owner=${repo.owner}`, "-F", `name=${repo.name}`, "-F", `number=${number}`], "gh api graphql"), "gh api graphql");
  const pr = requiredRecord(requiredRecord(requiredRecord(raw.data, "graphql.data").repository, "graphql.repository").pullRequest, "graphql.pullRequest");
  const reviews = requiredArray(requiredRecord(pr.reviews, "graphql.pullRequest.reviews").nodes, "graphql.pullRequest.reviews.nodes").map((entry, index) => {
    const review = requiredRecord(entry, `graphql.review[${index}]`);
    const author = review.author === null ? null : requiredString(requiredRecord(review.author, `graphql.review[${index}].author`).login, `graphql.review[${index}].author.login`);
    const commit = review.commit === null ? null : requiredString(requiredRecord(review.commit, `graphql.review[${index}].commit`).oid, `graphql.review[${index}].commit.oid`);
    return { state: requiredString(review.state, `graphql.review[${index}].state`), author, commitSha: commit, submittedAt: optionalString(review.submittedAt, `graphql.review[${index}].submittedAt`) };
  });
  return {
    state: requiredString(pr.state, "graphql.pullRequest.state"),
    isDraft: requiredBoolean(pr.isDraft, "graphql.pullRequest.isDraft"),
    mergeable: requiredString(pr.mergeable, "graphql.pullRequest.mergeable"),
    headSha: requiredString(pr.headRefOid, "graphql.pullRequest.headRefOid"),
    baseRefName: requiredString(pr.baseRefName, "graphql.pullRequest.baseRefName"),
    author: requiredString(requiredRecord(pr.author, "graphql.pullRequest.author").login, "graphql.pullRequest.author.login"),
    labels: labels(requiredRecord(pr.labels, "graphql.pullRequest.labels").nodes, "graphql.pullRequest.labels.nodes"),
    closingIssueNumbers: closingIssues(requiredRecord(pr.closingIssuesReferences, "graphql.pullRequest.closingIssuesReferences").nodes, "graphql.pullRequest.closingIssuesReferences.nodes"),
    reviews,
  };
}

async function loadRequiredChecks(runner: Runner, repo: { owner: string; name: string }, branch: string): Promise<RequiredCheck[]> {
  const raw = requiredRecord(await runJson(runner, ["gh", "api", `repos/${repo.owner}/${repo.name}/branches/${branch}/protection/required_status_checks`], "gh api required status checks"), "gh api required status checks");
  const contexts = requiredArray(raw.contexts, "required status checks.contexts").map((entry, index) => ({ context: requiredString(entry, `required status checks.contexts[${index}]`), appId: null }));
  const checks = raw.checks === undefined ? [] : requiredArray(raw.checks, "required status checks.checks").map((entry, index) => {
    const check = requiredRecord(entry, `required status checks.checks[${index}]`);
    return { context: requiredString(check.context, `required status checks.checks[${index}].context`), appId: optionalNumber(check.app_id, `required status checks.checks[${index}].app_id`) };
  });
  const deduplicated = new Map<string, RequiredCheck>();
  for (const required of [...contexts, ...checks]) deduplicated.set(`${required.context}\u0000${required.appId ?? ""}`, required);
  return [...deduplicated.values()];
}

export async function loadChecks(runner: Runner, repo: { owner: string; name: string }, sha: string): Promise<CheckResult[]> {
  const runs = requiredRecord(await runJson(runner, ["gh", "api", `repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?per_page=100`], "gh api check runs"), "gh api check runs");
  const statuses = requiredRecord(await runJson(runner, ["gh", "api", `repos/${repo.owner}/${repo.name}/commits/${sha}/status`], "gh api statuses"), "gh api statuses");
  const checkRuns = requiredArray(runs.check_runs, "check runs.check_runs").map((entry, index) => {
    const run = requiredRecord(entry, `check runs.check_runs[${index}]`);
    const status = requiredString(run.status, `check runs.check_runs[${index}].status`);
    const conclusion = optionalString(run.conclusion, `check runs.check_runs[${index}].conclusion`);
    const app = run.app === null || run.app === undefined ? null : requiredRecord(run.app, `check runs.check_runs[${index}].app`);
    return {
      name: requiredString(run.name, `check runs.check_runs[${index}].name`),
      state: status === "completed" && conclusion === "success" ? "SUCCESS" : conclusion?.toUpperCase() ?? status.toUpperCase(),
      appId: app ? requiredNumber(app.id, `check runs.check_runs[${index}].app.id`) : null,
      attemptAt: optionalString(run.started_at, `check runs.check_runs[${index}].started_at`),
      id: requiredNumber(run.id, `check runs.check_runs[${index}].id`),
    };
  });
  const statusContexts = requiredArray(statuses.statuses, "statuses.statuses").map((entry, index) => {
    const status = requiredRecord(entry, `statuses.statuses[${index}]`);
    return {
      name: requiredString(status.context, `statuses.statuses[${index}].context`),
      state: requiredString(status.state, `statuses.statuses[${index}].state`).toUpperCase(),
      appId: null,
      attemptAt: optionalString(status.created_at, `statuses.statuses[${index}].created_at`),
      id: requiredNumber(status.id, `statuses.statuses[${index}].id`),
    };
  });
  return [...checkRuns, ...statusContexts];
}

const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export async function loadMarker(runner: Runner, repo: { owner: string; name: string }, pr: number): Promise<GateMarker | null> {
  const comments: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const raw = requiredArray(await runJson(runner, ["gh", "api", `repos/${repo.owner}/${repo.name}/issues/${pr}/comments?per_page=100&page=${page}`], "gh api comments"), "gh api comments");
    comments.push(...raw);
    if (raw.length < 100) break;
  }
  for (const comment of [...comments].reverse()) {
    const parsed = requiredRecord(comment, "comment");
    if (!trustedAssociations.has(requiredString(parsed.author_association, "comment.author_association"))) continue;
    const marker = parseGateMarker(requiredString(parsed.body, "comment.body"));
    if (marker) return marker;
  }
  return null;
}

async function loadIssues(runner: Runner): Promise<SyncFacts["issues"]> {
  const raw = requiredArray(await runJson(runner, ["gh", "issue", "list", "--state", "all", "--limit", "1000", "--json", "number,state,labels"], "gh issue list"), "gh issue list");
  return raw.map((entry, index) => {
    const issue = requiredRecord(entry, `gh issue list[${index}]`);
    return { number: requiredNumber(issue.number, `gh issue list[${index}].number`), state: requiredString(issue.state, `gh issue list[${index}].state`), labels: labels(issue.labels, `gh issue list[${index}].labels`) };
  });
}

async function loadSyncPullRequests(runner: Runner, repo: { owner: string; name: string }): Promise<SyncFacts["pullRequests"]> {
  const raw = requiredArray(await runJson(runner, ["gh", "pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,mergedAt,headRefOid,labels,closingIssuesReferences"], "gh pr list"), "gh pr list");
  const parsed = raw.map((entry, index) => {
    const pr = requiredRecord(entry, `gh pr list[${index}]`);
    const number = requiredNumber(pr.number, `gh pr list[${index}].number`);
    const prLabels = labels(pr.labels, `gh pr list[${index}].labels`);
    return { number, state: optionalString(pr.mergedAt, `gh pr list[${index}].mergedAt`) === null ? requiredString(pr.state, `gh pr list[${index}].state`) : "MERGED", headSha: requiredString(pr.headRefOid, `gh pr list[${index}].headRefOid`), labels: prLabels, closingIssueNumbers: closingIssues(pr.closingIssuesReferences, `gh pr list[${index}].closingIssuesReferences`) };
  });
  const markers = await Promise.all(parsed.map(async (pr) => (pr.labels.includes("merge-ready") ? await loadMarker(runner, repo, pr.number) : null)));
  return parsed.map((pr, index) => ({ ...pr, marker: markers[index]! }));
}

interface ListedWorktree { path: string; branch: string | null }

function parseWorktrees(text: string): ListedWorktree[] {
  const result: ListedWorktree[] = [];
  for (const block of text.trim().split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    result.push({ path, branch: ref });
  }
  return result;
}

async function loadWorktrees(runner: Runner): Promise<SyncFacts["worktrees"]> {
  const common = await runner.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.exitCode !== 0) throw new OperationalError(`git rev-parse failed: ${common.stderr.trim()}`);
  const repoRoot = dirname(common.stdout.trim());
  const listed = await runner.run(["git", "worktree", "list", "--porcelain"]);
  if (listed.exitCode !== 0) throw new OperationalError(`git worktree list failed: ${listed.stderr.trim()}`);
  const managed = resolve(repoRoot, ".worktrees");
  const worktrees: SyncFacts["worktrees"] = [];
  for (const worktree of parseWorktrees(listed.stdout)) {
    const insideManagedDirectory = resolve(worktree.path).startsWith(`${managed}/`);
    let dirty = false;
    if (insideManagedDirectory) {
      const status = await runner.run(["git", "-C", worktree.path, "status", "--porcelain"]);
      if (status.exitCode !== 0) throw new OperationalError(`git status failed for ${worktree.path}: ${status.stderr.trim()}`);
      dirty = status.stdout.trim().length > 0;
    }
    worktrees.push({ ...worktree, dirty, insideManagedDirectory });
  }
  return worktrees;
}

async function applyActions(runner: Runner, actions: Evaluation["safeActions"], repo?: { owner: string; name: string }): Promise<void> {
  for (const action of actions) {
    let argv: string[];
    if (action.kind === "remove-merge-ready") argv = ["gh", "pr", "edit", String(action.pr), "--remove-label", "merge-ready"];
    else if (action.kind === "add-merge-ready") argv = ["gh", "pr", "edit", String(action.pr), "--add-label", "merge-ready"];
    else if (action.kind === "remove-wip") argv = ["gh", "issue", "edit", String(action.issue), "--remove-label", "WIP"];
    else if (action.kind === "create-marker") {
      if (!repo || !action.marker) throw new OperationalError("internal marker action is incomplete");
      argv = ["gh", "api", `repos/${repo.owner}/${repo.name}/issues/${action.pr}/comments`, "--method", "POST", "-f", `body=${encodeGateMarker(action.marker)}`];
    } else {
      if (!action.path || !safeManagedWorktreePath(action.path)) throw new OperationalError("refusing an unmanaged worktree removal");
      argv = ["git", "worktree", "remove", action.path];
    }
    const result = await runner.run(argv);
    if (result.exitCode !== 0) throw new OperationalError(`${argv[0]} mutation failed (${result.exitCode}): ${result.stderr.trim() || "no error output"}`);
  }
}

function safeManagedWorktreePath(path: string): boolean {
  if (!existsSync(path)) return false;
  const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.exitCode !== 0) return false;
  const root = dirname(common.stdout.toString().trim());
  const managed = resolve(realpathSync(root), ".worktrees");
  const candidate = realpathSync(path);
  return dirname(candidate) === managed && relative(managed, candidate) !== "";
}

export async function sync(runner: Runner, apply: boolean): Promise<Evaluation> {
  const repo = await repository(runner);
  const facts: SyncFacts = { issues: await loadIssues(runner), pullRequests: await loadSyncPullRequests(runner, repo), worktrees: await loadWorktrees(runner) };
  const evaluation = evaluateSync(facts);
  if (apply) await applyActions(runner, evaluation.safeActions, repo);
  return evaluation;
}

export async function gate(runner: Runner, issue: number, pr: number, evidence: GateEvidence, apply: boolean): Promise<Evaluation> {
  const repo = await repository(runner);
  const pullRequest = await loadPullRequest(runner, repo, pr);
  const facts: GateFacts = { issue, pr, defaultBranch: repo.defaultBranch, pullRequest, requiredChecks: await loadRequiredChecks(runner, repo, repo.defaultBranch), checks: await loadChecks(runner, repo, pullRequest.headSha), evidence, marker: await loadMarker(runner, repo, pr) };
  const evaluation = evaluateGate(facts);
  if (apply && evaluation.violations.length === 0) await applyActions(runner, evaluation.safeActions, repo);
  return evaluation;
}

export async function close(runner: Runner, issueNumber: number, prNumber: number, apply: boolean): Promise<Evaluation> {
  const repo = await repository(runner);
  const pullRequest = await loadPullRequest(runner, repo, prNumber);
  const issue = (await loadIssues(runner)).find((candidate) => candidate.number === issueNumber);
  if (!issue) throw new OperationalError(`issue #${issueNumber} was not returned by gh issue list`);
  const worktree = (await loadWorktrees(runner)).find((candidate) => matchingBranch(candidate.branch, issueNumber)) ?? null;
  const evaluation = evaluateClose({ issue, pullRequest: { number: prNumber, state: pullRequest.state, closingIssueNumbers: pullRequest.closingIssueNumbers }, worktree });
  if (apply && evaluation.violations.length === 0 && evaluation.refusals.length === 0) await applyActions(runner, evaluation.safeActions, repo);
  return evaluation;
}
