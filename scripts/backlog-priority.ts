export interface PriorityAssessment {
  version: 1;
  issue: number;
  provider: string;
  impact: number;
  urgency: number;
  unblock: number;
  riskReduction: number;
  confidence: number;
  effort: number;
  rationale: string;
}

export interface PriorityMarker {
  version: 1;
  assessment: PriorityAssessment;
  score: number;
}

export interface PriorityComment {
  marker: string;
  authorAssociation: string;
  createdAt: string;
  databaseId: number;
}

export interface QueueInput {
  number: number;
  createdAt: string;
  labels: string[];
  assessment: PriorityAssessment | null;
}

export interface QueueEntry {
  number: number;
  createdAt: string;
  labels: string[];
  assessed: boolean;
  score: number;
  components: Pick<PriorityAssessment, "impact" | "urgency" | "unblock" | "riskReduction" | "confidence" | "effort"> | null;
  rationale: string | null;
}

export interface LifecycleIssue {
  number: number;
  state: string;
  labels: string[];
  createdAt: string;
}

export interface LifecyclePullRequest {
  number: number;
  createdAt: string;
  gateAt: string | null;
  mergedAt: string | null;
}

export interface DurationSummary {
  sampleSize: number;
  median: number;
  p90: number;
}

export interface LifecycleMetrics {
  bounds: { since: string; until: string };
  mergedPullRequests: number;
  gatedPullRequests: number;
  currentWip: number;
  currentMergeReady: number;
  durations: {
    openToGate: DurationSummary | null;
    gateToMerge: DurationSummary | null;
    openToMerge: DurationSummary | null;
  };
}

type JsonRecord = Record<string, unknown>;

const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const markerPrefix = "<!-- kesha-backlog-priority:v1 ";
const markerSuffix = " -->";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requiredInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function exactKeys(record: JsonRecord, keys: string[], source: string): void {
  for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`${source} must not include ${key}`);
}

export function parsePriorityManifest(value: unknown, source = "priority manifest"): PriorityAssessment {
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  exactKeys(value, ["version", "issue", "provider", "impact", "urgency", "unblock", "riskReduction", "confidence", "effort", "rationale"], source);
  if (value.version !== 1) throw new Error(`${source}.version must equal 1`);
  const rationale = requiredString(value.rationale, `${source}.rationale`);
  if (rationale.length > 280) throw new Error(`${source}.rationale must be at most 280 characters`);
  return {
    version: 1,
    issue: requiredInteger(value.issue, `${source}.issue`, 1, Number.MAX_SAFE_INTEGER),
    provider: requiredString(value.provider, `${source}.provider`),
    impact: requiredInteger(value.impact, `${source}.impact`, 0, 5),
    urgency: requiredInteger(value.urgency, `${source}.urgency`, 0, 5),
    unblock: requiredInteger(value.unblock, `${source}.unblock`, 0, 5),
    riskReduction: requiredInteger(value.riskReduction, `${source}.riskReduction`, 0, 5),
    confidence: requiredInteger(value.confidence, `${source}.confidence`, 1, 5),
    effort: requiredInteger(value.effort, `${source}.effort`, 1, 5),
    rationale,
  };
}

export function computePriorityScore(assessment: PriorityAssessment): number {
  return Math.round(((4 * assessment.impact + 3 * assessment.urgency + 2 * assessment.unblock + 2 * assessment.riskReduction) * assessment.confidence / assessment.effort) * 100) / 100;
}

export function encodePriorityMarker(assessment: PriorityAssessment): string {
  return `${markerPrefix}${JSON.stringify({ version: 1, assessment, score: computePriorityScore(assessment) })}${markerSuffix}`;
}

export function parsePriorityMarker(body: string): PriorityMarker | null {
  const start = body.indexOf(markerPrefix);
  if (start === -1) return null;
  const end = body.indexOf(markerSuffix, start + markerPrefix.length);
  if (end === -1) throw new Error("priority marker is malformed");
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start + markerPrefix.length, end));
  } catch {
    throw new Error("priority marker is malformed");
  }
  if (!isRecord(raw) || raw.version !== 1) throw new Error("priority marker is malformed");
  const assessment = parsePriorityManifest(raw.assessment, "priority marker.assessment");
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score !== computePriorityScore(assessment)) {
    throw new Error("priority marker.score does not match assessment");
  }
  return { version: 1, assessment, score: raw.score };
}

export function selectCurrentAssessment(comments: PriorityComment[]): { assessment: PriorityAssessment; score: number; createdAt: string; databaseId: number } | null {
  const trusted = comments
    .filter((comment) => trustedAssociations.has(comment.authorAssociation))
    .map((comment) => ({ ...comment, parsed: parsePriorityMarker(comment.marker) }))
    .filter((comment): comment is PriorityComment & { parsed: PriorityMarker } => comment.parsed !== null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.databaseId - right.databaseId);
  const current = trusted.at(-1);
  return current ? { assessment: current.parsed.assessment, score: current.parsed.score, createdAt: current.createdAt, databaseId: current.databaseId } : null;
}

export function sortQueue(entries: QueueInput[]): QueueEntry[] {
  return entries
    .map((entry) => {
      const assessment = entry.assessment;
      return {
        number: entry.number,
        createdAt: entry.createdAt,
        labels: entry.labels,
        assessed: assessment !== null,
        score: assessment === null ? 0 : computePriorityScore(assessment),
        components: assessment === null ? null : {
          impact: assessment.impact,
          urgency: assessment.urgency,
          unblock: assessment.unblock,
          riskReduction: assessment.riskReduction,
          confidence: assessment.confidence,
          effort: assessment.effort,
        },
        rationale: assessment?.rationale ?? null,
      };
    })
    .sort((left, right) => Number(right.assessed) - Number(left.assessed) || right.score - left.score || left.createdAt.localeCompare(right.createdAt) || left.number - right.number);
}

function parsedTime(value: string, source: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`${source} must be an ISO timestamp`);
  return result;
}

function isInWindow(value: number, since: number, now: number): boolean {
  return value >= since && value <= now;
}

function duration(from: number, until: number, source: string): number {
  const value = (until - from) / 1000;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${source} has negative ${source.includes("gate") ? "open-to-gate" : "lifecycle"} duration`);
  return value;
}

function summary(values: number[]): DurationSummary | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
  return { sampleSize: ordered.length, median, p90: ordered[Math.ceil(ordered.length * 0.9) - 1]! };
}

export function evaluateMetrics(input: { since: string; now: string; issues: LifecycleIssue[]; pullRequests: LifecyclePullRequest[] }): LifecycleMetrics {
  const since = parsedTime(input.since, "since");
  const now = parsedTime(input.now, "now");
  if (since > now) throw new Error("since must not be after now");
  const openToGate: number[] = [];
  const gateToMerge: number[] = [];
  const openToMerge: number[] = [];
  let mergedPullRequests = 0;
  let gatedPullRequests = 0;
  for (const pullRequest of input.pullRequests) {
    const opened = parsedTime(pullRequest.createdAt, `PR #${pullRequest.number}.createdAt`);
    const gate = pullRequest.gateAt === null ? null : parsedTime(pullRequest.gateAt, `PR #${pullRequest.number}.gateAt`);
    const merged = pullRequest.mergedAt === null ? null : parsedTime(pullRequest.mergedAt, `PR #${pullRequest.number}.mergedAt`);
    if (gate !== null && gate < opened) throw new Error(`PR #${pullRequest.number} has negative open-to-gate duration`);
    if (merged !== null && merged < opened) throw new Error(`PR #${pullRequest.number} has negative open-to-merge duration`);
    if (gate !== null && merged !== null && merged < gate) throw new Error(`PR #${pullRequest.number} has negative gate-to-merge duration`);
    if (gate !== null && isInWindow(gate, since, now)) {
      gatedPullRequests += 1;
      openToGate.push((gate - opened) / 1000);
    }
    if (merged !== null && isInWindow(merged, since, now)) {
      mergedPullRequests += 1;
      openToMerge.push((merged - opened) / 1000);
      if (gate !== null) gateToMerge.push((merged - gate) / 1000);
    }
  }
  return {
    bounds: { since: new Date(since).toISOString(), until: new Date(now).toISOString() },
    mergedPullRequests,
    gatedPullRequests,
    currentWip: input.issues.filter((issue) => issue.state === "OPEN" && issue.labels.includes("WIP")).length,
    currentMergeReady: input.issues.filter((issue) => issue.state === "OPEN" && issue.labels.includes("merge-ready")).length,
    durations: { openToGate: summary(openToGate), gateToMerge: summary(gateToMerge), openToMerge: summary(openToMerge) },
  };
}
