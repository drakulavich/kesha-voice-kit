import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type JsonRecord = Record<string, unknown>;

export class CoordinationError extends Error {}

export interface ClaimManifest { version: 1; issue: number; holder: string; paths: string[]; ttlSeconds: number }
export interface ClaimMarker { version: 1; action: "claim" | "release"; manifest: ClaimManifest; expiresAt: string | null }
export interface ClaimRecord { issue: number; state: string; labels: string[]; authorAssociation: string; createdAt: string; id: number; marker: ClaimMarker }
export interface CollisionPlan {
  edges: Array<{ source: "claim" | "pull-request" | "worktree"; issue?: number; pr?: number; path: string }>;
  self: Array<{ source: "claim" | "pull-request" | "worktree"; issue?: number; pr?: number; path: string }>;
  idempotent: boolean;
  expiresAt: string | null;
  rejectedClaimIds: number[];
}
export interface LeaseState { version: 1; resource: string; holder: string; acquiredAt: string; expiresAt: string; host: string; pid: number }
export interface LeaseResult { state: "acquired" | "already-owned" | "refused" | "released" | "absent" | "held" | "expired"; lease: LeaseState | null; recovered?: boolean }

const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
function record(value: unknown, source: string): JsonRecord { if (!isRecord(value)) throw new CoordinationError(`${source} must be an object`); return value; }
function string(value: unknown, source: string): string { if (typeof value !== "string" || value.length === 0) throw new CoordinationError(`${source} must be a non-empty string`); return value; }
function number(value: unknown, source: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CoordinationError(`${source} must be an integer`); return value; }
function array(value: unknown, source: string): unknown[] { if (!Array.isArray(value)) throw new CoordinationError(`${source} must be an array`); return value; }
export function timestamp(value: unknown, source: string): string { const text = string(value, source); if (Number.isNaN(Date.parse(text))) throw new CoordinationError(`${source} must be an ISO timestamp`); return text; }

export function normalizedPath(value: unknown, source: string): string {
  const path = string(value, source);
  if (isAbsolute(path) || path.includes("\\") || path.includes("*") || path.endsWith("/")) throw new CoordinationError(`${source} must be a normalized repository-relative path`);
  if (path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new CoordinationError(`${source} must be a normalized repository-relative path`);
  return path;
}

function ttl(value: unknown, source: string): number { const seconds = number(value, source); if (seconds < 1 || seconds > 86_400) throw new CoordinationError(`${source} must be between 1 and 86400 seconds`); return seconds; }
export function parseClaimManifest(value: unknown, source = "claim manifest"): ClaimManifest {
  const manifest = record(value, source);
  if (manifest.version !== 1) throw new CoordinationError(`${source}.version must equal 1`);
  const issue = number(manifest.issue, `${source}.issue`);
  if (issue < 1) throw new CoordinationError(`${source}.issue must be positive`);
  const paths = array(manifest.paths, `${source}.paths`).map((path, index) => normalizedPath(path, `${source}.paths[${index}]`));
  if (paths.length === 0) throw new CoordinationError(`${source}.paths must not be empty`);
  return { version: 1, issue, holder: string(manifest.holder, `${source}.holder`), paths: [...new Set(paths)].sort(), ttlSeconds: ttl(manifest.ttlSeconds, `${source}.ttlSeconds`) };
}
export function sameManifest(left: ClaimManifest, right: ClaimManifest): boolean { return left.issue === right.issue && left.holder === right.holder && left.ttlSeconds === right.ttlSeconds && left.paths.length === right.paths.length && left.paths.every((path, index) => path === right.paths[index]); }
export function encodeClaimMarker(marker: ClaimMarker): string { return `<!-- kesha-backlog-claim:v1 ${JSON.stringify(marker)} -->`; }
export function parseClaimMarker(body: string): ClaimMarker | null {
  const match = /<!-- kesha-backlog-claim:v1 (\{.*\}) -->/.exec(body);
  if (!match?.[1]) return null;
  try {
    const marker = record(JSON.parse(match[1]), "claim marker");
    if (marker.version !== 1) return null;
    const action = string(marker.action, "claim marker.action");
    if (action !== "claim" && action !== "release") return null;
    const expiresAt = marker.expiresAt === null || marker.expiresAt === undefined ? null : timestamp(marker.expiresAt, "claim marker.expiresAt");
    if (action === "claim" && expiresAt === null) return null;
    return { version: 1, action, manifest: parseClaimManifest(marker.manifest, "claim marker.manifest"), expiresAt };
  } catch { return null; }
}

function overlap(left: string[], right: string[]): string | null { for (const candidate of left) if (right.some((other) => candidate === other || candidate.startsWith(`${other}/`) || other.startsWith(`${candidate}/`))) return candidate; return null; }
export function claimOrder(left: ClaimRecord, right: ClaimRecord): number { return left.createdAt.localeCompare(right.createdAt) || left.id - right.id; }
export function isLiveClaim(record: ClaimRecord, now: Date): boolean { return record.marker.action === "claim" && record.state === "OPEN" && record.labels.includes("WIP") && trustedAssociations.has(record.authorAssociation) && record.marker.expiresAt !== null && Date.parse(record.marker.expiresAt) > now.getTime(); }
export function issueNumberFromBranch(branch: string | null): number | null { const match = /^(?:[^/]+\/)?issue-([1-9]\d*)$/.exec(branch ?? ""); return match ? Number(match[1]) : null; }
export function evaluateCollisionPlan(manifest: ClaimManifest, facts: { claims: ClaimRecord[]; pullRequests: Array<{ number: number; closingIssueNumbers: number[]; files: string[] }>; worktrees: Array<{ branch: string | null; files: string[] }> }, now = new Date()): CollisionPlan {
  const accepted: ClaimRecord[] = [];
  const rejected: ClaimRecord[] = [];
  for (const candidate of facts.claims.filter((claim) => isLiveClaim(claim, now)).sort(claimOrder)) (accepted.some((claim) => overlap(claim.marker.manifest.paths, candidate.marker.manifest.paths) !== null) ? rejected : accepted).push(candidate);
  const edges: CollisionPlan["edges"] = [];
  const self: CollisionPlan["self"] = [];
  for (const claim of accepted) { const path = overlap(manifest.paths, claim.marker.manifest.paths); if (path !== null) (claim.issue === manifest.issue ? self : edges).push({ source: "claim", issue: claim.issue, path }); }
  for (const pullRequest of facts.pullRequests) { const path = overlap(manifest.paths, pullRequest.files); if (path !== null) (pullRequest.closingIssueNumbers.includes(manifest.issue) ? self : edges).push({ source: "pull-request", pr: pullRequest.number, path }); }
  for (const worktree of facts.worktrees) { const path = overlap(manifest.paths, worktree.files); if (path !== null) (issueNumberFromBranch(worktree.branch) === manifest.issue ? self : edges).push({ source: "worktree", path }); }
  const own = accepted.find((claim) => sameManifest(claim.marker.manifest, manifest)) ?? null;
  return { edges, self, idempotent: own !== null, expiresAt: own?.marker.expiresAt ?? null, rejectedClaimIds: rejected.map((claim) => claim.id) };
}

function resource(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new CoordinationError("lease resource must use 1-64 letters, digits, dots, underscores, or hyphens"); return value; }
function holder(value: string): string { if (value.length === 0 || value.length > 256) throw new CoordinationError("lease holder must be a non-empty string up to 256 characters"); return value; }
export function leaseDirectory(gitCommonDirectory: string): string { const common = resolve(gitCommonDirectory); let stat; try { stat = lstatSync(common); } catch { throw new CoordinationError("shared git common directory is missing"); } if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CoordinationError("shared git common directory must be a real directory"); return join(common, "kesha-backlog-leases"); }
function rootState(root: string, create: boolean): string | null {
  const requested = resolve(root); let parent; try { parent = lstatSync(dirname(requested)); } catch { throw new CoordinationError("lease root parent is missing"); }
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new CoordinationError("lease root parent must be a real directory");
  if (!existsSync(requested)) { if (!create) return null; try { mkdirSync(requested); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; } }
  const stat = lstatSync(requested); if (stat.isSymbolicLink()) throw new CoordinationError("lease root must not be a symlink"); if (!stat.isDirectory()) throw new CoordinationError("lease root must be a directory"); return requested;
}
function statePath(root: string, name: string): string { const path = resolve(root, `${resource(name)}.json`); const child = relative(root, path); if (child === "" || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) throw new CoordinationError("lease state path escapes its root"); return path; }
function parseLease(value: unknown, source: string): LeaseState { const lease = record(value, source); if (lease.version !== 1) throw new CoordinationError(`${source}.version must equal 1`); const pid = number(lease.pid, `${source}.pid`); if (pid < 1) throw new CoordinationError(`${source}.pid must be positive`); return { version: 1, resource: resource(string(lease.resource, `${source}.resource`)), holder: holder(string(lease.holder, `${source}.holder`)), acquiredAt: timestamp(lease.acquiredAt, `${source}.acquiredAt`), expiresAt: timestamp(lease.expiresAt, `${source}.expiresAt`), host: string(lease.host, `${source}.host`), pid }; }
function readLease(root: string, name: string): LeaseState | null { const path = statePath(root, name); if (!existsSync(path)) return null; const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new CoordinationError("lease state must not be a symlink"); if (!stat.isFile()) throw new CoordinationError("lease state must be a regular file"); let value; try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new CoordinationError("malformed lease state"); } const lease = parseLease(value, "lease state"); if (lease.resource !== name) throw new CoordinationError("lease state resource does not match its path"); return lease; }
function live(lease: LeaseState, now: Date): boolean { return Date.parse(lease.expiresAt) > now.getTime(); }
function guard(root: string, name: string, operation: () => LeaseResult): LeaseResult {
  const path = join(root, `.${name}.lock`); const temporary = join(root, `.${name}.${process.pid}.${randomUUID()}.lock-tmp`);
  try { writeFileSync(temporary, JSON.stringify({ version: 1, resource: name }), { encoding: "utf8", mode: 0o600, flag: "wx" }); try { linkSync(temporary, path); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; try { const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new CoordinationError("lease operation guard must not be a symlink"); } catch (error) { if (error instanceof CoordinationError) throw error; } throw new CoordinationError("lease operation is already in progress"); } } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  try { return operation(); } finally { unlinkSync(path); }
}
function assertNoGuard(root: string, name: string): void { const path = join(root, `.${name}.lock`); if (!existsSync(path)) return; const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new CoordinationError("lease operation guard must not be a symlink"); if (!stat.isFile()) throw new CoordinationError("lease operation guard must be a regular file"); try { const value = record(JSON.parse(readFileSync(path, "utf8")), "lease operation guard"); if (value.version !== 1 || value.resource !== name) throw new CoordinationError("malformed lease operation guard"); } catch (error) { if (error instanceof CoordinationError) throw error; throw new CoordinationError("malformed lease operation guard"); } throw new CoordinationError("lease operation is already in progress"); }
export function statusLease(root: string, name: string, now = new Date()): LeaseResult { const safeRoot = rootState(root, false); if (safeRoot === null) return { state: "absent", lease: null }; const safeName = resource(name); assertNoGuard(safeRoot, safeName); const lease = readLease(safeRoot, safeName); return lease === null ? { state: "absent", lease: null } : { state: live(lease, now) ? "held" : "expired", lease }; }
export function acquireLease(root: string, input: { resource: string; holder: string; ttlSeconds?: number }, now = new Date()): LeaseResult { const name = resource(input.resource); const owner = holder(input.holder); const seconds = ttl(input.ttlSeconds ?? 600, "lease ttlSeconds"); const safeRoot = rootState(root, true)!; try { return guard(safeRoot, name, () => { const path = statePath(safeRoot, name); const current = readLease(safeRoot, name); if (current && live(current, now)) return current.holder === owner ? { state: "already-owned", lease: current } : { state: "refused", lease: current }; const recovered = current !== null; if (current) unlinkSync(path); const lease: LeaseState = { version: 1, resource: name, holder: owner, acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + seconds * 1000).toISOString(), host: hostname(), pid: process.pid }; const temporary = join(safeRoot, `.${name}.${process.pid}.${randomUUID()}.tmp`); try { writeFileSync(temporary, JSON.stringify(lease), { encoding: "utf8", mode: 0o600, flag: "wx" }); try { linkSync(temporary, path); return { state: "acquired", lease, recovered }; } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; return { state: "refused", lease: readLease(safeRoot, name) }; } } finally { if (existsSync(temporary)) unlinkSync(temporary); } }); } catch (error) { if (error instanceof CoordinationError && error.message === "lease operation is already in progress") return { state: "refused", lease: readLease(safeRoot, name) }; throw error; } }
export function releaseLease(root: string, input: { resource: string; holder: string }, now = new Date()): LeaseResult { const name = resource(input.resource); const owner = holder(input.holder); const safeRoot = rootState(root, false); if (safeRoot === null) return { state: "absent", lease: null }; try { return guard(safeRoot, name, () => { const path = statePath(safeRoot, name); const current = readLease(safeRoot, name); if (current === null || !live(current, now)) return { state: "absent", lease: current }; if (current.holder !== owner) return { state: "refused", lease: current }; try { unlinkSync(path); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "absent", lease: null }; throw error; } return { state: "released", lease: current }; }); } catch (error) { if (error instanceof CoordinationError && error.message === "lease operation is already in progress") return { state: "refused", lease: readLease(safeRoot, name) }; throw error; } }
