#!/usr/bin/env bun
/**
 * Holds every `model-plan.json` size against the bytes its pinned URL actually serves.
 *
 * #887/#896 found `kesha install --plan` under-reporting CharsiuG2P by 72.9 MB, hand-written
 * in #509 and undetected for two months: `assert_plan_paths` compares `relPath` only, and no
 * offline test can falsify a size. The honest invariant needs the network, which is why this
 * runs weekly rather than per PR (#920).
 *
 * `relPath` is the join key. `model-plan.json` records the sizes, `rust/src/models/` records
 * the URLs, and the rust manifest test already holds those two path lists identical. The URLs
 * are read out of the models sources instead of copied here, so this file cannot drift from the pins —
 * and a plan entry whose `relPath` resolves to no URL fails the run rather than being skipped,
 * which is what stops a parser regression from going quietly green.
 *
 * HEAD first, falling back to a one-byte range request for hosts that answer HEAD without a
 * Content-Length: no downloads either way, no cache impact. `KESHA_MODEL_MIRROR` is deliberately
 * not honoured — the subject here is upstream truth.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { humanBytes } from "../../src/format";

const MODELS_DIR = join(import.meta.dir, "..", "..", "rust", "src", "models");

// Computed here rather than imported from tests/helpers: that helper pulls in `yaml` transitively,
// and a production script reaching into the test tree for a runtime dependency is the #993 shape.
function modelsSourcePaths(): string[] {
  return readdirSync(MODELS_DIR, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".rs"))
    .sort()
    .map((entry) => join(MODELS_DIR, entry));
}

export interface PlanEntry {
  group: string;
  relPath: string;
  sizeBytes: number;
}

export interface Verdict {
  entry: PlanEntry;
  status: "ok" | "drift" | "unchecked";
  message: string;
}

function planFile(group: string, value: unknown): PlanEntry {
  const { relPath, sizeBytes } = (value ?? {}) as { relPath?: unknown; sizeBytes?: unknown };
  if (typeof relPath !== "string" || typeof sizeBytes !== "number") {
    throw new Error(`install plan ${group} needs relPath and sizeBytes, got ${JSON.stringify(value)}`);
  }
  return { group, relPath, sizeBytes };
}

/** Every recorded file in the plan, whatever shape its group takes. */
export function flattenPlan(plan: unknown): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const [group, value] of Object.entries(plan as Record<string, unknown>)) {
    if (Array.isArray(value)) entries.push(...value.map((file) => planFile(group, file)));
    else if (value && typeof value === "object" && "relPath" in value) entries.push(planFile(group, value));
    else
      for (const [lang, file] of Object.entries(value as Record<string, unknown>))
        entries.push(planFile(`${group}.${lang}`, file));
  }
  return entries;
}

function balanced(source: string, from: number, open: string, close: string) {
  const start = source.indexOf(open, from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return { inner: source.slice(start + 1, i), end: i + 1 };
  }
  return null;
}

/** Joins the string literals of a `concat!(…)` or yields the single literal. */
function literalValue(text: string): string | null {
  const parts = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return parts.length > 0 ? parts.join("") : null;
}

function topLevelArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (const ch of text) {
    if (ch === '"') inString = !inString;
    if (!inString && ch === "(") depth++;
    if (!inString && ch === ")") depth--;
    if (!inString && ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  args.push(current);
  return args.map((a) => a.trim()).filter(Boolean);
}

interface MacroArm {
  params: string[];
  template: string;
}

/**
 * Expands the `ModelFile`-building macros in place, so their entries are read from the same
 * url template the compiler uses. Kokoro's voice packs exist only in that form.
 */
function expandModelFileMacros(source: string): string {
  const macros = new Map<string, MacroArm>();
  let stripped = "";
  let at = 0;
  for (const decl of source.matchAll(/macro_rules!\s+(\w+)\s*\{/g)) {
    const name = decl[1];
    const body = balanced(source, decl.index + decl[0].length - 1, "{", "}");
    if (!name || !body) continue;
    const arm = /\(([^)]*)\)\s*=>\s*\{/.exec(body.inner);
    const template = arm && balanced(body.inner, arm.index + arm[0].length - 1, "{", "}");
    if (arm && template && template.inner.includes("ModelFile")) {
      macros.set(name, {
        params: [...(arm[1] ?? "").matchAll(/(\$\w+):/g)].map((p) => p[1] ?? ""),
        template: template.inner,
      });
    }
    // The definition itself must not reach the ModelFile scan: its `$name` placeholders
    // would register as a rel_path nothing resolves.
    stripped += source.slice(at, decl.index);
    at = body.end;
  }
  stripped += source.slice(at);

  for (const [name, arm] of macros) {
    // A self-referential template would never stop expanding; the models sources have none today.
    if (arm.template.includes(`${name}!`)) continue;
    const call = new RegExp(`\\b${name}!\\s*\\(`);
    for (let match = call.exec(stripped); match; match = call.exec(stripped)) {
      const args = balanced(stripped, match.index + match[0].length - 1, "(", ")");
      if (!args) break;
      const values = topLevelArgs(args.inner);
      const expanded = arm.params.reduce(
        (text, param, i) => text.split(param).join(values[i] ?? '""'),
        arm.template,
      );
      stripped = stripped.slice(0, match.index) + expanded + stripped.slice(args.end);
    }
  }
  return stripped;
}

export interface ManifestEntry {
  relPath: string;
  url: string;
}

/**
 * Every `ModelFile` the models sources pin, `cfg` gating included, in source order. English and
 * Mandarin ANE bundles stage identical basenames into different directories, so `relPath` is
 * not a unique key across the whole file — callers that need every entry (not just one per
 * `relPath`) must use this rather than `parseManifestUrls`'s deduping map (#1096 review).
 */
export function parseManifestEntries(source: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const modelFile = /ModelFile\s*\{\s*rel_path:\s*([\s\S]*?),\s*url:\s*([\s\S]*?),\s*sha256:/g;
  for (const match of expandModelFileMacros(source).matchAll(modelFile)) {
    const relPath = literalValue(match[1] ?? "");
    const url = literalValue(match[2] ?? "");
    if (relPath && url) entries.push({ relPath, url });
  }
  return entries;
}

/** `rel_path` → `url` for every `ModelFile` the models sources pin, `cfg` gating included. */
export function parseManifestUrls(source: string): Map<string, string> {
  const urls = new Map<string, string>();
  for (const { relPath, url } of parseManifestEntries(source)) urls.set(relPath, url);
  return urls;
}

/**
 * The transfer length is not the file length: HuggingFace gzips small text files, and the
 * compressed count would read as drift for every one of them.
 */
export function contentLength(headers: Headers): number | null {
  const encoding = headers.get("content-encoding");
  if (encoding && encoding !== "identity") return null;
  const raw = headers.get("content-length");
  const bytes = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(bytes) ? bytes : null;
}

/** Just enough of `fetch` to be substitutable in a test. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LiveSizeOptions {
  fetchImpl?: FetchLike;
  attempts?: number;
  backoffMs?: number;
}

/** The whole resource length a 206 reports, which is not the length of the bytes it served. */
export function rangeTotal(headers: Headers): number | null {
  const total = /\/(\d+)$/.exec(headers.get("content-range")?.trim() ?? "")?.[1];
  const bytes = total === undefined ? Number.NaN : Number(total);
  return Number.isInteger(bytes) ? bytes : null;
}

// The size lives on the far side of HuggingFace's 302, and only in an identity encoding.
const HEAD_PROBE: RequestInit = { method: "HEAD", headers: { "accept-encoding": "identity" } };
const RANGE_PROBE: RequestInit = {
  method: "GET",
  headers: { "accept-encoding": "identity", range: "bytes=0-0" },
};

async function probeSize(
  url: string,
  { fetchImpl, attempts, backoffMs }: Required<LiveSizeOptions>,
  init: RequestInit,
  sizeOf: (res: Response) => number | null,
): Promise<number | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await Bun.sleep(backoffMs * 2 ** (attempt - 2));
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
        ...init,
      });
      // Retried like a dropped connection: a CDN omitting Content-Length intermittently would otherwise spend its one attempt and file the drift issue.
      const bytes = res.ok ? sizeOf(res) : null;
      if (bytes !== null) return bytes;
    } catch {
      // Swallowed so the loop can retry; a transient blip must never read as a wrong size.
    }
  }
  return null;
}

/**
 * Bytes the URL serves, or null if the run could not find out.
 *
 * Backed off in seconds, not milliseconds: bun's fetch drops connections to github.com
 * ("socket connection was closed unexpectedly") in bursts lasting tens of seconds, so a
 * fast retry just lands in the same burst. Measured at 4/6 from cold processes while a
 * 250 ms/500 ms retry failed every time. A weekly job that files an issue over that would
 * train everyone to ignore it.
 */
export async function liveSize(
  url: string,
  { fetchImpl = fetch, attempts = 4, backoffMs = 1000 }: LiveSizeOptions = {},
): Promise<number | null> {
  const options = { fetchImpl, attempts, backoffMs };
  const head = await probeSize(url, options, HEAD_PROBE, (res) => contentLength(res.headers));
  if (head !== null) return head;
  // raw.githubusercontent.com answers HEAD 200 with no Content-Length at all, which left the
  // plan's one non-HuggingFace entry permanently unmeasurable (#1054). Asking for a single
  // byte costs no download and reports the whole length in Content-Range.
  return probeSize(url, options, RANGE_PROBE, (res) =>
    res.status === 206 ? rangeTotal(res.headers) : contentLength(res.headers),
  );
}

export function compareEntry(entry: PlanEntry, live: number | null): Verdict {
  const where = `${entry.relPath} (${entry.group})`;
  if (live === null) {
    return { entry, status: "unchecked", message: `${where}: no Content-Length could be read` };
  }
  if (live === entry.sizeBytes) {
    return { entry, status: "ok", message: `${where}: ${live} bytes` };
  }
  const delta = live - entry.sizeBytes;
  const sign = delta > 0 ? "+" : "-";
  return {
    entry,
    status: "drift",
    message:
      `${where}: recorded ${entry.sizeBytes} bytes (${humanBytes(entry.sizeBytes)}), ` +
      `live ${live} bytes (${humanBytes(live)}), ` +
      `delta ${sign}${Math.abs(delta)} bytes (${sign}${humanBytes(Math.abs(delta))})`,
  };
}

function argValue(flag: string, fallback: string): string {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

if (import.meta.main) {
  const planPath = argValue("--plan", "model-plan.json");
  // `--manifest` still names one file so a pinned ref can be checked; the default follows `models` wherever it lives (#950).
  const explicit = argValue("--manifest", "");
  const manifestPaths = explicit ? [explicit] : modelsSourcePaths();
  const manifestPath = manifestPaths.join(", ");

  const entries = flattenPlan(JSON.parse(readFileSync(planPath, "utf8")));
  const urls = parseManifestUrls(manifestPaths.map((path) => readFileSync(path, "utf8")).join("\n"));

  const unresolved = entries.filter((entry) => !urls.has(entry.relPath));
  if (unresolved.length > 0) {
    console.error(
      `FAIL: ${unresolved.length} plan entr${unresolved.length === 1 ? "y has" : "ies have"} no URL in ${manifestPath}:`,
    );
    for (const entry of unresolved) console.error(`  - ${entry.relPath} (${entry.group})`);
    console.error(`\n  Either the manifest dropped the file, or this script stopped reading it.`);
    process.exit(1);
  }

  const verdicts: Verdict[] = [];
  for (const entry of entries) {
    const verdict = compareEntry(entry, await liveSize(urls.get(entry.relPath)!));
    console.log(`${verdict.status === "ok" ? "ok" : verdict.status.toUpperCase()}: ${verdict.message}`);
    verdicts.push(verdict);
  }

  const drift = verdicts.filter((v) => v.status === "drift");
  const unchecked = verdicts.filter((v) => v.status === "unchecked");
  if (drift.length > 0) {
    console.error(`\n${drift.length} of ${entries.length} recorded sizes no longer match upstream:`);
    for (const v of drift) console.error(`  - ${v.message}`);
    console.error(`\n  Fix: correct sizeBytes in ${planPath} — the live length is the truth.`);
  }
  if (unchecked.length > 0) {
    console.error(`\n${unchecked.length} of ${entries.length} could not be checked at all:`);
    for (const v of unchecked) console.error(`  - ${v.message}`);
    console.error(`\n  The sizes are not implicated; this run proved nothing about them.`);
  }
  if (drift.length > 0 || unchecked.length > 0) process.exit(1);

  console.log(`\nAll ${entries.length} recorded sizes match the bytes their pinned URLs serve.`);
}
