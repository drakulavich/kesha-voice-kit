import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { acquireLease, claimOrder, encodeClaimMarker, evaluateCollisionPlan, isLiveClaim, issueNumberFromBranch, leaseDirectory, normalizedPath, parseClaimManifest, parseClaimMarker, releaseLease, sameManifest, statusLease, timestamp, type ClaimManifest, type ClaimMarker, type ClaimRecord, type CollisionPlan, type LeaseResult, type LeaseState } from "./backlog-coordination";
import { encodePriorityMarker, evaluateMetrics, parsePriorityMarker, selectCurrentAssessment, sortQueue, type LifecycleIssue, type LifecyclePullRequest, type PriorityAssessment, type PriorityComment, type QueueEntry } from "./backlog-priority";

export { acquireLease, encodeClaimMarker, evaluateCollisionPlan, issueNumberFromBranch, leaseDirectory, parseClaimManifest, releaseLease, statusLease } from "./backlog-coordination";
export type { ClaimManifest, ClaimMarker, ClaimRecord, CollisionPlan, LeaseResult, LeaseState } from "./backlog-coordination";

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

type GateEvidencePayload = Omit<GateEvidence, "digest">;

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
    gateVerified: boolean;
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
  safeActions: Array<{ kind: "add-merge-ready" | "remove-merge-ready" | "remove-wip" | "remove-worktree" | "create-marker" | "create-claim" | "release-claim" | "acquire-lease" | "release-lease"; pr?: number; issue?: number; path?: string; resource?: string; marker?: GateMarker | ClaimMarker }>;
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

interface Repository {
  owner: string;
  name: string;
  defaultBranch: string;
}

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

function matchingBranch(branch: string | null, issue: number): boolean {
  return issueNumberFromBranch(branch) === issue;
}

export function isDirectManagedWorktree(path: string, managedDirectory: string): boolean {
  try {
    const requested = resolve(path);
    if (lstatSync(requested).isSymbolicLink()) return false;
    const candidate = realpathSync(requested);
    const managed = realpathSync(managedDirectory);
    const child = relative(managed, candidate);
    return child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`) && dirname(child) === ".";
  } catch {
    return false;
  }
}

function sameNumbers(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && actual.every((number, index) => number === expected[index]);
}

function actionKey(action: Evaluation["safeActions"][number]): string {
  if (action.kind === "create-marker") return `${action.kind}:${action.pr}:${JSON.stringify(action.marker)}`;
  if (action.kind === "create-claim" || action.kind === "release-claim") return `${action.kind}:${action.issue}:${JSON.stringify(action.marker)}`;
  if (action.kind === "remove-worktree") return `${action.kind}:${action.path}`;
  return `${action.kind}:${action.pr ?? action.issue}`;
}

function uniqueActions(actions: Evaluation["safeActions"]): Evaluation["safeActions"] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = actionKey(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function encodeGateMarker(marker: GateMarker): string {
  return `<!-- kesha-backlog-gate:v1 ${JSON.stringify(marker)} -->`;
}

export function canonicalGateEvidencePayload(evidence: GateEvidencePayload): string {
  return JSON.stringify({
    version: evidence.version,
    provider: evidence.provider,
    verdict: evidence.verdict,
    headSha: evidence.headSha,
    uri: evidence.uri,
  });
}

export function digestGateEvidence(evidence: GateEvidencePayload): string {
  return createHash("sha256").update(canonicalGateEvidencePayload(evidence)).digest("hex");
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
  const parsed = { version: 1 as const, provider, verdict: "APPROVED" as const, headSha, uri, digest };
  if (digest.toLowerCase() !== digestGateEvidence(parsed)) throw new OperationalError(`${source}.digest does not match canonical evidence payload`);
  return parsed;
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
  const latestReviewByAuthor = new Map<string, { state: string; submittedAt: string }>();
  for (const review of pr.reviews) {
    if (review.author === null || review.author === pr.author || review.commitSha !== pr.headSha || review.submittedAt === null) continue;
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED") continue;
    const current = latestReviewByAuthor.get(review.author);
    if (!current || review.submittedAt > current.submittedAt) latestReviewByAuthor.set(review.author, { state: review.state, submittedAt: review.submittedAt });
  }
  if ([...latestReviewByAuthor.values()].some((review) => review.state === "CHANGES_REQUESTED")) violations.push("an independent reviewer requested changes on the current head");
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
  const marker: GateMarker = { version: 1, issue: facts.issue, pr: facts.pr, evidence: facts.evidence };
  const markerCurrent = facts.marker !== null && facts.marker.issue === facts.issue && facts.marker.pr === facts.pr && facts.marker.evidence.headSha === pr.headSha;
  const safeActions: Evaluation["safeActions"] = [];
  if (violations.length === 0 && marker && !markerCurrent) safeActions.push({ kind: "create-marker", pr: facts.pr, marker });
  if (violations.length === 0 && !pr.labels.includes("merge-ready")) safeActions.push({ kind: "add-merge-ready", pr: facts.pr });
  return { violations, refusals: [], safeActions: uniqueActions(safeActions), findings: [] };
}

export function evaluateSync(facts: SyncFacts): Evaluation {
  const findings: string[] = [];
  const safeActions: Evaluation["safeActions"] = [];
  for (const pr of facts.pullRequests) {
    if (
      pr.labels.includes("merge-ready") &&
      (!pr.gateVerified || !pr.marker || pr.marker.pr !== pr.number || !sameNumbers(pr.closingIssueNumbers, [pr.marker.issue]) || pr.marker.evidence.headSha !== pr.headSha)
    ) {
      findings.push(`PR #${pr.number} has stale merge-ready evidence`);
      safeActions.push({ kind: "remove-merge-ready", pr: pr.number });
    }
    if ((pr.state === "CLOSED" || pr.state === "MERGED") && pr.closingIssueNumbers.length === 1) {
      const issue = facts.issues.find((candidate) => candidate.number === pr.closingIssueNumbers[0]);
      if (issue?.labels.includes("WIP")) {
        if (issue.state === "CLOSED") {
          findings.push(`issue #${issue.number} retains WIP after PR #${pr.number} ${pr.state.toLowerCase()}`);
          safeActions.push({ kind: "remove-wip", issue: issue.number });
        } else {
          findings.push(`issue #${issue.number} retains WIP after PR #${pr.number} ${pr.state.toLowerCase()}; automatic cleanup requires a closed issue`);
        }
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
  return { violations: [], refusals: [], safeActions: uniqueActions(safeActions), findings };
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
  if (violations.length === 0 && refusals.length === 0 && facts.issue.labels.includes("WIP")) safeActions.push({ kind: "remove-wip", issue: facts.issue.number });
  return { violations, refusals, safeActions: uniqueActions(safeActions), findings: [] };
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

async function repository(runner: Runner): Promise<Repository> {
  const raw = requiredRecord(await runJson(runner, ["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"], "gh repo view"), "gh repo view");
  const [owner, name] = requiredString(raw.nameWithOwner, "gh repo view.nameWithOwner").split("/");
  if (!owner || !name) throw new OperationalError("gh repo view.nameWithOwner must be owner/name");
  const defaultBranch = requiredString(requiredRecord(raw.defaultBranchRef, "gh repo view.defaultBranchRef").name, "gh repo view.defaultBranchRef.name");
  return { owner, name, defaultBranch };
}

const pullRequestQuery = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { number state isDraft mergeable headRefOid baseRefName author { login } labels(first: 100) { nodes { name } } closingIssuesReferences(first: 10) { nodes { number } } reviews(last: 100) { nodes { state submittedAt author { login } commit { oid } } } } } }`;

async function loadPullRequest(runner: Runner, repo: Pick<Repository, "owner" | "name">, number: number): Promise<GateFacts["pullRequest"]> {
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

async function loadRequiredChecks(runner: Runner, repo: Pick<Repository, "owner" | "name">, branch: string): Promise<RequiredCheck[]> {
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

export async function loadChecks(runner: Runner, repo: Pick<Repository, "owner" | "name">, sha: string): Promise<CheckResult[]> {
  const statuses = requiredRecord(await runJson(runner, ["gh", "api", `repos/${repo.owner}/${repo.name}/commits/${sha}/status`], "gh api statuses"), "gh api statuses");
  const allRuns: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const runs = requiredRecord(await runJson(runner, ["gh", "api", `repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`], "gh api check runs"), "gh api check runs");
    const pageRuns = requiredArray(runs.check_runs, "check runs.check_runs");
    allRuns.push(...pageRuns);
    if (pageRuns.length < 100) break;
  }
  const checkRuns = allRuns.map((entry, index) => {
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
const pageCap = 100;

async function pagedArray(runner: Runner, endpoint: (page: number) => string, source: string): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let page = 1; page <= pageCap; page += 1) {
    const current = requiredArray(await runJson(runner, ["gh", "api", endpoint(page)], source), source);
    values.push(...current);
    if (current.length < 100) return values;
  }
  throw new OperationalError(`${source} reached pagination cap; refusing incomplete result`);
}

function priorityComments(values: unknown[], source: string): PriorityComment[] {
  return values.map((entry, index) => {
    const comment = requiredRecord(entry, `${source}[${index}]`);
    return {
      marker: requiredString(comment.body, `${source}[${index}].body`),
      authorAssociation: requiredString(comment.author_association, `${source}[${index}].author_association`),
      createdAt: requiredString(comment.created_at, `${source}[${index}].created_at`),
      databaseId: requiredNumber(comment.id, `${source}[${index}].id`),
    };
  });
}

async function loadPriorityAssessment(runner: Runner, repo: Pick<Repository, "owner" | "name">, issue: number) {
  return selectCurrentAssessment(priorityComments(await pagedArray(runner, (page) => `repos/${repo.owner}/${repo.name}/issues/${issue}/comments?per_page=100&page=${page}`, "gh api priority comments"), "priority comment"));
}

function sameAssessment(left: PriorityAssessment, right: PriorityAssessment): boolean {
  return left.version === right.version && left.issue === right.issue && left.provider === right.provider && left.impact === right.impact && left.urgency === right.urgency && left.unblock === right.unblock && left.riskReduction === right.riskReduction && left.confidence === right.confidence && left.effort === right.effort && left.rationale === right.rationale;
}

export async function prioritize(runner: Runner, assessment: PriorityAssessment, apply: boolean): Promise<Evaluation & { accepted: boolean; assessment: PriorityAssessment; score: number }> {
  const repo = await repository(runner);
  const issue = requiredRecord(await runJson(runner, ["gh", "api", `repos/${repo.owner}/${repo.name}/issues/${assessment.issue}`], "gh api priority issue"), "gh api priority issue");
  if (requiredNumber(issue.number, "priority issue.number") !== assessment.issue) throw new OperationalError("priority issue number does not match request");
  if (requiredString(issue.state, "priority issue.state") !== "open") return { findings: [], refusals: [], safeActions: [], violations: [`issue #${assessment.issue} must be open`], accepted: false, assessment, score: 0 };
  if (issue.pull_request !== undefined) return { findings: [], refusals: [], safeActions: [], violations: [`issue #${assessment.issue} must not be a pull request`], accepted: false, assessment, score: 0 };
  const current = await loadPriorityAssessment(runner, repo, assessment.issue);
  const score = Math.round(((4 * assessment.impact + 3 * assessment.urgency + 2 * assessment.unblock + 2 * assessment.riskReduction) * assessment.confidence / assessment.effort) * 100) / 100;
  if (current && sameAssessment(current.assessment, assessment)) return { findings: ["matching priority assessment already current"], refusals: [], safeActions: [], violations: [], accepted: true, assessment, score };
  if (!apply) return { findings: [], refusals: [], safeActions: [{ kind: "create-marker", issue: assessment.issue }], violations: [], accepted: false, assessment, score };
  const posted = requiredRecord(await runJson(runner, ["gh", "api", `repos/${repo.owner}/${repo.name}/issues/${assessment.issue}/comments`, "--method", "POST", "-f", `body=${encodePriorityMarker(assessment)}`], "gh api priority mutation"), "gh api priority mutation");
  const postedId = requiredNumber(posted.id, "priority mutation.id");
  const after = await loadPriorityAssessment(runner, repo, assessment.issue);
  if (!after || after.databaseId !== postedId) return { findings: [], refusals: [], safeActions: [], violations: ["priority assessment was superseded before confirmation"], accepted: false, assessment, score };
  return { findings: ["priority assessment accepted"], refusals: [], safeActions: [], violations: [], accepted: true, assessment: after.assessment, score: after.score };
}

interface QueueIssue { number: number; state: string; labels: string[]; createdAt: string }

async function loadPriorityIssues(runner: Runner, repo: Pick<Repository, "owner" | "name">, state: "open" | "all" = "open"): Promise<QueueIssue[]> {
  return pagedArray(runner, (page) => `repos/${repo.owner}/${repo.name}/issues?state=${state}&per_page=100&page=${page}`, "gh api priority issues").then((values) => values.map((entry, index) => {
    const issue = requiredRecord(entry, `priority issue[${index}]`);
    return { number: requiredNumber(issue.number, `priority issue[${index}].number`), state: requiredString(issue.state, `priority issue[${index}].state`).toUpperCase(), labels: labels(issue.labels, `priority issue[${index}].labels`), createdAt: requiredString(issue.createdAt ?? issue.created_at, `priority issue[${index}].createdAt`) };
  }));
}

export async function queue(runner: Runner, label?: string, limit?: number): Promise<{ entries: QueueEntry[] }> {
  const repo = await repository(runner);
  const issues = (await loadPriorityIssues(runner, repo)).filter((issue) => !issue.labels.some((candidate) => candidate === "WIP" || candidate === "needs-decision" || candidate === "wontfix") && (label === undefined || issue.labels.includes(label)));
  const entries = sortQueue(await Promise.all(issues.map(async (issue) => ({ ...issue, assessment: (await loadPriorityAssessment(runner, repo, issue.number))?.assessment ?? null }))));
  return { entries: limit === undefined ? entries : entries.slice(0, limit) };
}

async function loadHistoricalGate(runner: Runner, repo: Pick<Repository, "owner" | "name">, pullRequest: { number: number; headSha: string; closingIssueNumbers: number[] }): Promise<string | null> {
  const comments = await pagedArray(runner, (page) => `repos/${repo.owner}/${repo.name}/issues/${pullRequest.number}/comments?per_page=100&page=${page}`, "gh api gate comments");
  const valid: Array<{ createdAt: string; databaseId: number }> = [];
  for (const [index, entry] of comments.entries()) {
    const comment = requiredRecord(entry, `gate comment[${index}]`);
    if (!trustedAssociations.has(requiredString(comment.author_association, `gate comment[${index}].author_association`))) continue;
    const body = requiredString(comment.body, `gate comment[${index}].body`);
    const marker = parseGateMarker(body);
    if (body.includes("<!-- kesha-backlog-gate:v1 ") && marker === null) throw new OperationalError("trusted gate marker is malformed");
    if (!marker || marker.pr !== pullRequest.number || pullRequest.closingIssueNumbers.length !== 1 || marker.issue !== pullRequest.closingIssueNumbers[0] || marker.evidence.headSha !== pullRequest.headSha) continue;
    valid.push({ createdAt: requiredString(comment.created_at, `gate comment[${index}].created_at`), databaseId: requiredNumber(comment.id, `gate comment[${index}].id`) });
  }
  valid.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.databaseId - right.databaseId);
  return valid.at(-1)?.createdAt ?? null;
}

export async function metrics(runner: Runner, since: string, now = new Date()) {
  const repo = await repository(runner);
  const issues = await loadPriorityIssues(runner, repo, "all");
  const raw = requiredArray(await runJson(runner, ["gh", "pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,createdAt,mergedAt,headRefOid,labels,closingIssuesReferences"], "gh pr metrics list"), "gh pr metrics list");
  if (raw.length === 1000) throw new OperationalError("metrics pull request list reached limit; refusing incomplete result");
  const pullRequests: LifecyclePullRequest[] = await Promise.all(raw.map(async (entry, index) => {
    const pullRequest = requiredRecord(entry, `metrics pull request[${index}]`);
    const number = requiredNumber(pullRequest.number, `metrics pull request[${index}].number`);
    const closingIssueNumbers = closingIssues(pullRequest.closingIssuesReferences, `metrics pull request[${index}].closingIssuesReferences`);
    return {
      number,
      createdAt: requiredString(pullRequest.createdAt, `metrics pull request[${index}].createdAt`),
      mergedAt: optionalString(pullRequest.mergedAt, `metrics pull request[${index}].mergedAt`),
      gateAt: await loadHistoricalGate(runner, repo, { number, headSha: requiredString(pullRequest.headRefOid, `metrics pull request[${index}].headRefOid`), closingIssueNumbers }),
      state: requiredString(pullRequest.state, `metrics pull request[${index}].state`),
      labels: labels(pullRequest.labels, `metrics pull request[${index}].labels`),
    };
  }));
  const metricIssues: LifecycleIssue[] = issues.map((issue) => ({ number: issue.number, state: issue.state, labels: issue.labels, createdAt: issue.createdAt }));
  return evaluateMetrics({ since, now: now.toISOString(), issues: metricIssues, pullRequests });
}

export async function loadMarker(runner: Runner, repo: Pick<Repository, "owner" | "name">, pr: number): Promise<GateMarker | null> {
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

export async function loadClaims(runner: Runner, repo: Pick<Repository, "owner" | "name">, issues: Array<{ number: number; state: string; labels: string[] }>, now = new Date()): Promise<ClaimRecord[]> {
  const markers: ClaimRecord[] = [];
  for (const issue of issues) {
    if (issue.state !== "OPEN" || !issue.labels.includes("WIP")) continue;
    for (let page = 1; ; page += 1) {
      const raw = requiredArray(await runJson(runner, ["gh", "api", `repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments?per_page=100&page=${page}`], "gh api claim comments"), "gh api claim comments");
      for (const entry of raw) {
        const comment = requiredRecord(entry, "claim comment");
        const authorAssociation = requiredString(comment.author_association, "claim comment.author_association");
        if (!trustedAssociations.has(authorAssociation)) continue;
        const marker = parseClaimMarker(requiredString(comment.body, "claim comment.body"));
        if (!marker || marker.manifest.issue !== issue.number) continue;
        markers.push({ issue: issue.number, state: issue.state, labels: issue.labels, authorAssociation, createdAt: timestamp(comment.created_at, "claim comment.created_at"), id: requiredNumber(comment.id, "claim comment.id"), marker, releasedAt: null, releasedId: null });
      }
      if (raw.length < 100) break;
    }
  }
  const releases = markers.filter((record) => record.marker.action === "release");
  const claims = markers
    .filter((record) => record.marker.action === "claim")
    .map((record) => {
      const release = releases
          .filter(
            (release) =>
              sameManifest(release.marker.manifest, record.marker.manifest) &&
              claimOrder(release, record) > 0,
          )
          .sort(claimOrder)[0] ?? null;
      return {
        ...record,
        releasedAt: release?.createdAt ?? null,
        releasedId: release?.id ?? null,
      };
    });
  void now;
  return claims.sort(claimOrder);
}

export async function loadPullRequestFiles(runner: Runner, repo: Pick<Repository, "owner" | "name">, pr: number): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; ; page += 1) {
    const raw = requiredArray(await runJson(runner, ["gh", "api", `repos/${repo.owner}/${repo.name}/pulls/${pr}/files?per_page=100&page=${page}`], "gh api pull request files"), "gh api pull request files");
    files.push(...raw.map((entry, index) => normalizedPath(requiredRecord(entry, `pull request files[${index}]`).filename, `pull request files[${index}].filename`)));
    if (raw.length < 100) break;
  }
  return [...new Set(files)].sort();
}

async function loadOpenPullRequests(runner: Runner, repo: Pick<Repository, "owner" | "name">): Promise<Array<{ number: number; closingIssueNumbers: number[]; files: string[] }>> {
  const raw = requiredArray(await runJson(runner, ["gh", "pr", "list", "--state", "open", "--limit", "1000", "--json", "number,closingIssuesReferences"], "gh pr list"), "gh pr list");
  if (raw.length === 1000) throw new OperationalError("collision pull request list reached limit; refusing incomplete graph");
  return Promise.all(raw.map(async (entry, index) => {
    const pullRequest = requiredRecord(entry, `gh pr list[${index}]`);
    const number = requiredNumber(pullRequest.number, `gh pr list[${index}].number`);
    return { number, closingIssueNumbers: closingIssues(pullRequest.closingIssuesReferences, `gh pr list[${index}].closingIssuesReferences`), files: await loadPullRequestFiles(runner, repo, number) };
  }));
}

function statusPaths(output: string): string[] {
  const paths: string[] = [];
  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    paths.push(normalizedPath(entry.slice(3), "git status path"));
    if ((code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") && entries[index + 1]) paths.push(normalizedPath(entries[++index]!, "git status renamed path"));
  }
  return [...new Set(paths)].sort();
}

export async function loadCollisionWorktrees(runner: Runner): Promise<Array<{ branch: string | null; files: string[] }>> {
  const listed = await runner.run(["git", "worktree", "list", "--porcelain"]);
  if (listed.exitCode !== 0) throw new OperationalError(`git worktree list failed: ${listed.stderr.trim()}`);
  const result: Array<{ branch: string | null; files: string[] }> = [];
  for (const worktree of parseWorktrees(listed.stdout)) {
    const committed = await runner.run(["git", "-C", worktree.path, "diff", "--no-renames", "--name-only", "origin/main...HEAD"]);
    if (committed.exitCode !== 0) throw new OperationalError(`git diff failed for ${worktree.path}: ${committed.stderr.trim()}`);
    const status = await runner.run(["git", "-C", worktree.path, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status.exitCode !== 0) throw new OperationalError(`git status failed for ${worktree.path}: ${status.stderr.trim()}`);
    result.push({ branch: worktree.branch, files: [...new Set([...committed.stdout.split("\n").filter(Boolean).map((path) => normalizedPath(path, "git diff path")), ...statusPaths(status.stdout)])].sort() });
  }
  return result;
}

async function collisionFacts(runner: Runner, repo: Repository, now: Date): Promise<{ issues: SyncFacts["issues"]; claims: ClaimRecord[]; pullRequests: Array<{ number: number; closingIssueNumbers: number[]; files: string[] }>; worktrees: Array<{ branch: string | null; files: string[] }> }> {
  const issues = await loadCollisionIssues(runner);
  return { issues, claims: await loadClaims(runner, repo, issues, now), pullRequests: await loadOpenPullRequests(runner, repo), worktrees: await loadCollisionWorktrees(runner) };
}

function claimEvaluation(plan: CollisionPlan, manifest: ClaimManifest, marker: ClaimMarker | null): Evaluation {
  if (plan.edges.length > 0) return { findings: [], refusals: [], safeActions: [], violations: ["claim collides with active repository work"] };
  if (plan.idempotent) return { findings: ["matching live claim already accepted"], refusals: [], safeActions: [], violations: [] };
  if (marker === null) return { findings: [], refusals: [], safeActions: [], violations: [] };
  return { findings: [], refusals: [], safeActions: [{ kind: marker.action === "claim" ? "create-claim" : "release-claim", issue: manifest.issue, marker }], violations: [] };
}

async function postClaimMarker(runner: Runner, repo: Pick<Repository, "owner" | "name">, issue: number, marker: ClaimMarker): Promise<void> {
  const result = await runner.run(["gh", "api", `repos/${repo.owner}/${repo.name}/issues/${issue}/comments`, "--method", "POST", "-f", `body=${encodeClaimMarker(marker)}`]);
  if (result.exitCode !== 0) throw new OperationalError(`gh api claim mutation failed (${result.exitCode}): ${result.stderr.trim() || "no error output"}`);
}

export async function claim(runner: Runner, manifest: ClaimManifest, apply: boolean, now = new Date()): Promise<Evaluation> {
  const repo = await repository(runner);
  const before = await collisionFacts(runner, repo, now);
  const issue = before.issues.find((candidate) => candidate.number === manifest.issue);
  if (!issue || issue.state !== "OPEN" || !issue.labels.includes("WIP")) return { findings: [], refusals: [], safeActions: [], violations: [`issue #${manifest.issue} must be open and labeled WIP`] };
  const expiresAt = new Date(now.getTime() + manifest.ttlSeconds * 1000).toISOString();
  const marker: ClaimMarker = { version: 1, action: "claim", manifest, expiresAt };
  const initial = claimEvaluation(evaluateCollisionPlan(manifest, before, now), manifest, marker);
  if (!apply || initial.violations.length > 0 || initial.safeActions.length === 0) return initial;
  await postClaimMarker(runner, repo, manifest.issue, marker);
  const after = await collisionFacts(runner, repo, now);
  const final = evaluateCollisionPlan(manifest, after, now);
  if (!final.idempotent || final.edges.length > 0) {
    const release: ClaimMarker = { version: 1, action: "release", manifest, expiresAt: null };
    await postClaimMarker(runner, repo, manifest.issue, release);
    const compensated = await collisionFacts(runner, repo, now);
    if (compensated.claims.some((record) => sameManifest(record.marker.manifest, manifest) && isLiveClaim(record, now))) throw new OperationalError("claim compensation release was not observed after re-read");
    return { findings: [], refusals: [], safeActions: [], violations: [final.idempotent ? "claim became colliding after acquisition; marker was released" : "claim lost deterministic collision arbitration"] };
  }
  return { findings: ["claim acquired"], refusals: [], safeActions: [], violations: [] };
}

export async function plan(runner: Runner, manifest: ClaimManifest, now = new Date()): Promise<{ evaluation: Evaluation; plan: CollisionPlan }> {
  const repo = await repository(runner);
  const facts = await collisionFacts(runner, repo, now);
  const issue = facts.issues.find((candidate) => candidate.number === manifest.issue);
  if (!issue || issue.state !== "OPEN" || !issue.labels.includes("WIP")) return { plan: { edges: [], self: [], idempotent: false, expiresAt: null, rejectedClaimIds: [] }, evaluation: { findings: [], refusals: [], safeActions: [], violations: [`issue #${manifest.issue} must be open and labeled WIP`] } };
  const collisionPlan = evaluateCollisionPlan(manifest, facts, now);
  return {
    plan: collisionPlan,
    evaluation: {
      findings: collisionPlan.self.map((entry) => `self ${entry.source} overlap at ${entry.path}`),
      refusals: [],
      safeActions: [],
      violations: collisionPlan.edges.map((entry) => `collision with ${entry.source} at ${entry.path}`),
    },
  };
}

export async function releaseClaim(runner: Runner, manifest: ClaimManifest, apply: boolean, now = new Date()): Promise<Evaluation> {
  const repo = await repository(runner);
  const before = await collisionFacts(runner, repo, now);
  const existing = before.claims.find((record) => sameManifest(record.marker.manifest, manifest) && isLiveClaim(record, now));
  if (!existing) return { findings: ["matching live claim is already absent"], refusals: [], safeActions: [], violations: [] };
  const marker: ClaimMarker = { version: 1, action: "release", manifest, expiresAt: null };
  const result: Evaluation = { findings: [], refusals: [], safeActions: [{ kind: "release-claim", issue: manifest.issue, marker }], violations: [] };
  if (!apply) return result;
  await postClaimMarker(runner, repo, manifest.issue, marker);
  const after = await collisionFacts(runner, repo, now);
  if (after.claims.some((record) => sameManifest(record.marker.manifest, manifest) && isLiveClaim(record, now))) throw new OperationalError("claim release marker was not observed after re-read");
  return { findings: ["claim released"], refusals: [], safeActions: [], violations: [] };
}

export async function leaseRoot(runner: Runner): Promise<string> {
  const result = await runner.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (result.exitCode !== 0) throw new OperationalError(`git rev-parse failed: ${result.stderr.trim() || "no error output"}`);
  return leaseDirectory(result.stdout.trim());
}

export function evaluateLeaseOperation(operation: "acquire" | "release" | "status", input: { resource: string; holder?: string }, observed: LeaseResult): Evaluation {
  if (operation === "status") return { findings: [observed.state], violations: [], refusals: [], safeActions: [] };
  if (observed.state === "refused") return { findings: [], violations: [], refusals: ["resource lease is held by another holder or operation is busy"], safeActions: [] };
  if (observed.state === "acquired" || observed.state === "released") return { findings: [observed.state], violations: [], refusals: [], safeActions: [] };
  if (observed.state === "already-owned") return { findings: ["already-owned"], violations: [], refusals: [], safeActions: [] };
  if (observed.state === "held" && observed.lease?.holder !== input.holder) return { findings: [], violations: [], refusals: ["resource lease is held by another holder"], safeActions: [] };
  if (operation === "acquire") {
    if (observed.state === "held") return { findings: ["already-owned"], violations: [], refusals: [], safeActions: [] };
    return { findings: [], violations: [], refusals: [], safeActions: [{ kind: "acquire-lease", resource: input.resource }] };
  }
  if (observed.state !== "held") return { findings: ["absent"], violations: [], refusals: [], safeActions: [] };
  return { findings: [], violations: [], refusals: [], safeActions: [{ kind: "release-lease", resource: input.resource }] };
}

async function loadIssues(runner: Runner): Promise<SyncFacts["issues"]> {
  const raw = requiredArray(await runJson(runner, ["gh", "issue", "list", "--state", "all", "--limit", "1000", "--json", "number,state,labels"], "gh issue list"), "gh issue list");
  return raw.map((entry, index) => {
    const issue = requiredRecord(entry, `gh issue list[${index}]`);
    return { number: requiredNumber(issue.number, `gh issue list[${index}].number`), state: requiredString(issue.state, `gh issue list[${index}].state`), labels: labels(issue.labels, `gh issue list[${index}].labels`) };
  });
}

async function loadCollisionIssues(runner: Runner): Promise<SyncFacts["issues"]> {
  const raw = requiredArray(await runJson(runner, ["gh", "issue", "list", "--state", "open", "--label", "WIP", "--limit", "1000", "--json", "number,state,labels"], "gh collision issue list"), "gh collision issue list");
  if (raw.length === 1000) throw new OperationalError("collision issue list reached limit; refusing incomplete graph");
  return raw.map((entry, index) => {
    const issue = requiredRecord(entry, `gh collision issue list[${index}]`);
    return { number: requiredNumber(issue.number, `gh collision issue list[${index}].number`), state: requiredString(issue.state, `gh collision issue list[${index}].state`), labels: labels(issue.labels, `gh collision issue list[${index}].labels`) };
  });
}

async function loadSyncPullRequests(runner: Runner, repo: Repository): Promise<SyncFacts["pullRequests"]> {
  const raw = requiredArray(await runJson(runner, ["gh", "pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,mergedAt,headRefOid,labels,closingIssuesReferences"], "gh pr list"), "gh pr list");
  const parsed = raw.map((entry, index) => {
    const pr = requiredRecord(entry, `gh pr list[${index}]`);
    const number = requiredNumber(pr.number, `gh pr list[${index}].number`);
    const prLabels = labels(pr.labels, `gh pr list[${index}].labels`);
    return { number, state: optionalString(pr.mergedAt, `gh pr list[${index}].mergedAt`) === null ? requiredString(pr.state, `gh pr list[${index}].state`) : "MERGED", headSha: requiredString(pr.headRefOid, `gh pr list[${index}].headRefOid`), labels: prLabels, closingIssueNumbers: closingIssues(pr.closingIssuesReferences, `gh pr list[${index}].closingIssuesReferences`) };
  });
  const requiredChecks = parsed.some((pr) => pr.labels.includes("merge-ready"))
    ? await loadRequiredChecks(runner, repo, repo.defaultBranch)
    : [];
  return Promise.all(parsed.map(async (pr) => {
    if (!pr.labels.includes("merge-ready")) return { ...pr, marker: null, gateVerified: false };
    const marker = await loadMarker(runner, repo, pr.number);
    if (!marker) return { ...pr, marker: null, gateVerified: false };
    const pullRequest = await loadPullRequest(runner, repo, pr.number);
    const facts: GateFacts = {
      issue: marker.issue,
      pr: pr.number,
      defaultBranch: repo.defaultBranch,
      pullRequest,
      requiredChecks,
      checks: await loadChecks(runner, repo, pullRequest.headSha),
      evidence: marker.evidence,
      marker,
    };
    return { ...pr, marker, gateVerified: evaluateGate(facts).violations.length === 0 };
  }));
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
    const insideManagedDirectory = isDirectManagedWorktree(worktree.path, managed);
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
      argv = ["gh", "api", `repos/${repo.owner}/${repo.name}/issues/${action.pr}/comments`, "--method", "POST", "-f", `body=${encodeGateMarker(action.marker as GateMarker)}`];
    } else if (action.kind === "create-claim" || action.kind === "release-claim") {
      throw new OperationalError("claim actions must use the claim boundary");
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
  return isDirectManagedWorktree(path, resolve(root, ".worktrees"));
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
