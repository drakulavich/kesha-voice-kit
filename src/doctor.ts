import { existsSync } from "fs";
import { cacheComponentPaths, isInsideDir } from "./cache-layout";
import { errorMessage } from "./error-utils";
import { humanBytes } from "./format";
import { dirname, join } from "path";
import { getEngineBinPath, isEngineInstalled, type EngineCapabilities } from "./engine";
import {
  CORRUPT_STATE,
  engineFunctionalHealth,
  NOT_FUNCTIONAL_STATE,
  probeExecutable,
} from "./engine-health";
import { readInstalledEngineVersion } from "./engine-version-marker";
import { keshaCacheDir } from "./paths";
import { engineVersion, packageName, packageVersion } from "./package-info";
import { getStatsStatus, type StatsStatus } from "./stats";
import {
  fluidKokoroCacheInfo,
  type FluidKokoroCacheInfo,
} from "./fluid-kokoro-cache";
import { isCoremlBackend } from "./fluid-asr-cache";
import {
  fluidExternalRoots,
  fluidExternalTotalBytes,
  type FluidExternalRoot,
} from "./fluid-roots";
import { diagnosticHomeDir, dirSizeBytes } from "./diagnostic-paths";
import {
  getDiagnosticLogStatus,
  resolveDiagnosticLogDir,
  type DiagnosticLogStatus,
} from "./diagnostic-log";

const KNOWN_ENV_KEYS = [
  "KESHA_ENGINE_BIN",
  "KESHA_CACHE_DIR",
  "KESHA_MODEL_MIRROR",
  "KESHA_STATS_DB",
  "KESHA_DEBUG",
  "KESHA_DEBUG_FD",
  "KESHA_KOKORO_COMPUTE_UNITS",
  "KESHA_DIARIZE_COMPUTE_UNITS",
  "KESHA_DIARIZE_TIMEOUT_SECS",
  "KESHA_DIARIZE_LOAD_TIMEOUT_SECS",
] as const;

interface DoctorOptions {
  redact?: boolean;
  /** Every legacy FluidAudio root is home-relative; injecting the home makes the report testable (#688). */
  homeDir?: string;
}

interface PathSummary {
  path: string;
  exists: boolean;
  sizeBytes: number;
}

interface CacheComponent extends PathSummary {
  label: string;
}

interface OptionalComponent extends PathSummary {
  name: string;
  note?: string;
  /** Binaries only: whether the file actually executes. Absent for model directories. */
  runnable?: boolean;
}

type DoctorDiagnosticLogStatus = DiagnosticLogStatus & { error?: string };

/**
 * How the Recorded Engine version relates to the Pinned Engine version. `differs-from-pin`
 * is a supported state (`kesha install --engine-version`), not a fault — `unrecorded` is
 * separate so a missing marker is never reported as a difference.
 */
export type EngineVersionState = "matches-pin" | "differs-from-pin" | "unrecorded";

export function engineVersionState(
  versionMarker: string | null,
  pinnedVersion: string,
): EngineVersionState {
  if (versionMarker === null) return "unrecorded";
  return versionMarker === pinnedVersion ? "matches-pin" : "differs-from-pin";
}

export interface DoctorReport {
  generatedAt: string;
  redacted: boolean;
  package: {
    name: string;
    version: string;
  };
  runtime: {
    bunVersion: string;
    platform: string;
    arch: string;
  };
  engine: {
    path: string;
    installed: boolean;
    versionMarker: string | null;
    pinnedVersion: string;
    versionState: EngineVersionState;
    /** False when the binary is present but the OS refuses to run it (#770). */
    runnable: boolean;
    capabilities: EngineCapabilities | null;
    probeError: string | null;
  };
  cache: {
    path: string;
    exists: boolean;
    /** The Kesha cache plus an engine installed outside it. */
    totalBytes: number;
    components: CacheComponent[];
    externalRoots: FluidExternalRoot[];
    externalTotalBytes: number;
    /** Everything Kesha put on disk, wherever it landed. */
    grandTotalBytes: number;
  };
  optionalComponents: OptionalComponent[];
  stats: StatsStatus | (Partial<StatsStatus> & { error: string });
  diagnosticLogs: DoctorDiagnosticLogStatus;
  env: Record<string, string | null>;
}

function pathSummary(path: string): PathSummary {
  return {
    path,
    exists: existsSync(path),
    sizeBytes: dirSizeBytes(path),
  };
}

function isSecretKey(key: string): boolean {
  const secretParts = ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"];
  return key
    .split(/[^a-z0-9]+/i)
    .some((part) => secretParts.includes(part.toUpperCase()));
}

function redactUrl(value: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, value.endsWith("/") ? "/" : "");
  } catch {
    return null;
  }
}

function redactHomePaths(value: string, homeDir: string): string | null {
  const normalizedValue = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedHome = homeDir.replaceAll("\\", "/").replace(/\/+$/, "");
  const compareValue = process.platform === "win32" ? normalizedValue.toLowerCase() : normalizedValue;
  const compareHome = process.platform === "win32" ? normalizedHome.toLowerCase() : normalizedHome;

  if (compareValue === compareHome) return "~";
  if (compareValue.startsWith(`${compareHome}/`)) {
    return `~${normalizedValue.slice(normalizedHome.length)}`;
  }
  const escapedHome = normalizedHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const homePattern = new RegExp(`${escapedHome}(?=$|/)`, process.platform === "win32" ? "gi" : "g");
  const redacted = normalizedValue.replace(homePattern, (_match, offset: number) => {
    const previous = normalizedValue[offset - 1];
    return previous && !/[\s"'(:=]/.test(previous) ? "/~" : "~";
  });
  return redacted === normalizedValue ? null : redacted;
}

export function redactDiagnosticValue(
  key: string,
  value: string | null,
  homeDir = diagnosticHomeDir(),
): string | null {
  if (value === null) return null;
  if (isSecretKey(key)) return "[REDACTED]";

  const url = redactUrl(value);
  if (url) {
    const redactedUrlPaths = homeDir ? redactHomePaths(url, homeDir) : null;
    return redactedUrlPaths ?? url;
  }

  if (homeDir) {
    const redactedHomePaths = redactHomePaths(value, homeDir);
    if (redactedHomePaths !== null) return redactedHomePaths;
  }
  return value;
}

function redactPath(path: string, redact: boolean): string {
  return redact ? redactDiagnosticValue("path", path) ?? path : path;
}

function redactString(key: string, value: string | null, redact: boolean): string | null {
  return redact ? redactDiagnosticValue(key, value) : value;
}

function redactComponent<T extends PathSummary>(component: T, redact: boolean): T {
  if (!redact) return component;
  return { ...component, path: redactPath(component.path, true) };
}

async function collectEngine(redact: boolean): Promise<DoctorReport["engine"]> {
  const binPath = getEngineBinPath();
  const installed = isEngineInstalled();
  let capabilities: EngineCapabilities | null = null;
  let probeError: string | null = null;
  // A truncated download exists and the #796 stub even runs, so neither `installed` nor a
  // clean spawn says the engine works — only its own account of itself does (#801).
  const health = installed
    ? await engineFunctionalHealth()
    : ({ status: "missing" } as const);

  if (health.status === "unusable") {
    probeError = `binary is present but does not run (${health.detail}); re-run \`kesha install\``;
  } else if (health.status === "mute") {
    probeError = `${health.detail}; re-run \`kesha install\``;
  } else if (health.status === "ok") {
    capabilities = health.capabilities;
  }

  const versionMarker = readInstalledEngineVersion(binPath);

  return {
    path: redactPath(binPath, redact),
    installed,
    versionMarker,
    pinnedVersion: engineVersion,
    versionState: engineVersionState(versionMarker, engineVersion),
    runnable: health.status !== "missing" && health.status !== "unusable",
    capabilities,
    probeError: redactString("probeError", probeError, redact),
  };
}

function redactExternalRoot(root: FluidExternalRoot, redact: boolean): FluidExternalRoot {
  if (!redact) return root;
  return {
    ...root,
    path: redactPath(root.path, true),
    subsystems: root.subsystems.map((s) => ({ ...s, path: redactPath(s.path, true) })),
  };
}

function collectCache(
  redact: boolean,
  backend?: string,
  homeDir?: string,
): DoctorReport["cache"] {
  const cache = keshaCacheDir();
  const binPath = getEngineBinPath();
  const engineDir = dirname(dirname(binPath));
  const components: CacheComponent[] = cacheComponentPaths(
    cache,
    engineDir,
    isCoremlBackend(backend),
  ).map((component) => ({ label: component.label, ...pathSummary(component.path) }));
  const engineOutsideCache = isInsideDir(engineDir, cache) ? 0 : dirSizeBytes(engineDir);
  const totalBytes = dirSizeBytes(cache) + engineOutsideCache;
  const externalRoots = fluidExternalRoots({ homeDir, cacheRoot: cache });
  const externalTotalBytes = fluidExternalTotalBytes(externalRoots);

  return {
    path: redactPath(cache, redact),
    exists: existsSync(cache),
    totalBytes,
    components: components.map((component) => redactComponent(component, redact)),
    externalRoots: externalRoots.map((root) => redactExternalRoot(root, redact)),
    externalTotalBytes,
    grandTotalBytes: totalBytes + externalTotalBytes,
  };
}

const SIDECAR_COMPONENTS = [
  { name: "AVSpeech sidecar", note: "macOS voices", file: "say-avspeech" },
  { name: "Text language sidecar", note: "darwin text language fast path", file: "kesha-textlang" },
];

/** Reporting a truncated sidecar as "installed" is a false clean — spawn it instead (#770). */
async function sidecarComponent(
  spec: (typeof SIDECAR_COMPONENTS)[number],
  sidecarDir: string,
): Promise<OptionalComponent> {
  const summary = pathSummary(join(sidecarDir, spec.file));
  const base = { name: spec.name, note: spec.note, ...summary };
  if (!summary.exists) return base;
  const health = await probeExecutable(summary.path);
  return { ...base, runnable: health.status === "ok" };
}

async function collectOptionalComponents(
  redact: boolean,
  fluidKokoro: FluidKokoroCacheInfo,
): Promise<OptionalComponent[]> {
  const cache = keshaCacheDir();
  const sidecarDir = dirname(getEngineBinPath());
  const components: OptionalComponent[] = [
    {
      name: "VAD (Silero)",
      note: "enabled with `kesha install --vad`",
      ...pathSummary(join(cache, "models/silero-vad")),
    },
    {
      name: "TTS (Kokoro)",
      note: "enabled with `kesha install --tts`",
      ...pathSummary(join(cache, "models/kokoro-82m")),
    },
    {
      name: "TTS (Vosk RU)",
      note: "enabled with `kesha install --tts`",
      ...pathSummary(join(cache, "models/vosk-ru")),
    },
    ...(fluidKokoro.supported
      ? [
          {
            name: "FluidAudio Kokoro cache",
            note: "darwin-arm64; managed by FluidAudio outside Kesha's pinned model cache",
            path: fluidKokoro.path,
            exists: fluidKokoro.exists,
            sizeBytes: fluidKokoro.sizeBytes,
          },
        ]
      : []),
    {
      // Diarization (#199) and Kokoro (#207) run in-engine now (native
      // fluidaudio-rs) — no Swift sidecar binaries. The Sortformer model is
      // the only installable diarization artifact; Kokoro is covered by the
      // "TTS (Kokoro)" entry above.
      name: "Diarization (Sortformer)",
      note: "enabled with `kesha install --diarize` (darwin-arm64); runs in-engine",
      ...pathSummary(join(cache, "models/diarize")),
    },
    ...(await Promise.all(SIDECAR_COMPONENTS.map((spec) => sidecarComponent(spec, sidecarDir)))),
  ];
  return components.map((component) => redactComponent(component, redact));
}

function collectStats(redact: boolean): DoctorReport["stats"] {
  try {
    const status = getStatsStatus();
    return redact
      ? { ...status, dbPath: redactPath(status.dbPath, true) }
      : status;
  } catch (err) {
    return {
      error: redactString("statsError", errorMessage(err), redact) ?? "unknown",
    };
  }
}

function collectDiagnosticLogs(redact: boolean): DoctorReport["diagnosticLogs"] {
  try {
    const status = getDiagnosticLogStatus();
    return redact
      ? {
          ...status,
          dir: redactPath(status.dir, true),
          activePath: redactPath(status.activePath, true),
          statePath: redactPath(status.statePath, true),
        }
      : status;
  } catch (err) {
    const dir = resolveDiagnosticLogDir();
    const activePath = join(dir, "kesha.ndjson");
    const statePath = join(dir, "diagnostic-logs.json");
    return {
      dir: redactPath(dir, redact),
      activePath: redactPath(activePath, redact),
      statePath: redactPath(statePath, redact),
      exists: false,
      activeSizeBytes: 0,
      rotatedFiles: [],
      totalSizeBytes: 0,
      mode: "retain-on-failure",
      maxBytes: 10 * 1024 * 1024,
      retain: 5,
      error:
        redactString("diagnosticLogsError", errorMessage(err), redact) ??
        "unknown",
    };
  }
}

function collectEnv(redact: boolean): DoctorReport["env"] {
  const env: Record<string, string | null> = {};
  for (const key of KNOWN_ENV_KEYS) {
    env[key] = redactString(key, process.env[key] ?? null, redact);
  }
  return env;
}

export async function collectDoctorReport(
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const redact = options.redact === true;
  const fluidKokoro = fluidKokoroCacheInfo();
  const engine = await collectEngine(redact);
  return {
    generatedAt: new Date().toISOString(),
    redacted: redact,
    package: { name: packageName, version: packageVersion },
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    engine,
    cache: collectCache(redact, engine.capabilities?.backend, options.homeDir),
    optionalComponents: await collectOptionalComponents(redact, fluidKokoro),
    stats: collectStats(redact),
    diagnosticLogs: collectDiagnosticLogs(redact),
    env: collectEnv(redact),
  };
}

function formatComponentState(component: OptionalComponent): string {
  if (!component.exists) return "missing";
  return component.runnable === false ? CORRUPT_STATE : "installed";
}

function formatEngineBinaryState(engine: DoctorReport["engine"]): string {
  if (!engine.installed) return "missing";
  if (!engine.runnable) return CORRUPT_STATE;
  return engine.capabilities ? "installed" : NOT_FUNCTIONAL_STATE;
}

function formatVersionState(engine: DoctorReport["engine"]): string {
  switch (engine.versionState) {
    case "differs-from-pin":
      return (
        `installed v${engine.versionMarker} differs from the pinned v${engine.pinnedVersion} — ` +
        "supported; `kesha install` without --engine-version restores the pin"
      );
    case "unrecorded":
      return engine.installed
        ? "no recorded version beside the binary; `kesha install` records one"
        : "no engine installed";
    default:
      return "matches the pin";
  }
}

function formatCapabilities(engine: DoctorReport["engine"]): string {
  if (!engine.capabilities) return engine.probeError ?? "not available";
  const { backend, protocolVersion, features } = engine.capabilities;
  return `${backend}, protocol v${protocolVersion}, ${features.join(", ")}`;
}

function formatCacheSection(cache: DoctorReport["cache"]): string[] {
  const header = `Cache: ${cache.path} (${cache.exists ? humanBytes(cache.totalBytes) : "missing"})`;
  const rows = cache.components.map(
    (c) => `  ${c.label}: ${c.exists ? humanBytes(c.sizeBytes) : "missing"}`,
  );
  return [header, ...rows, ...formatExternalRootsSection(cache)];
}

/** Roots FluidAudio keeps for itself. Named with full paths because there is no `kesha uninstall`. */
function formatExternalRootsSection(cache: DoctorReport["cache"]): string[] {
  if (cache.externalRoots.length === 0) return [];
  const lines = ["", "FluidAudio caches outside the Kesha cache:"];
  for (const root of cache.externalRoots) {
    lines.push(`  ${root.path}: ${humanBytes(root.sizeBytes)}`);
    for (const s of root.subsystems) {
      lines.push(`    ${s.label}: ${humanBytes(s.sizeBytes)}`);
    }
    if (root.otherBytes > 0) {
      lines.push(`    ${humanBytes(root.otherBytes)} not read by the engine`);
    }
  }
  lines.push(`  Grand total: ${humanBytes(cache.grandTotalBytes)}`);
  return lines;
}

function formatOptionalSection(components: DoctorReport["optionalComponents"]): string[] {
  const lines = ["", "Optional components:"];
  for (const c of components) {
    const note = c.note ? ` - ${c.note}` : "";
    lines.push(`  ${c.name}: ${formatComponentState(c)}${note}`);
  }
  return lines;
}

function formatStatsSection(stats: DoctorReport["stats"]): string[] {
  const lines = ["", "Stats:"];
  if ("error" in stats) {
    lines.push(`  Error: ${stats.error}`);
  } else {
    lines.push(`  Enabled: ${stats.enabled ? "yes" : "no"}`);
    lines.push(`  Database: ${stats.dbPath}`);
    lines.push(`  Runs: ${stats.runCount}`);
  }
  return lines;
}

function formatDiagnosticLogsSection(logs: DoctorReport["diagnosticLogs"]): string[] {
  const lines = [
    "",
    "Diagnostic logs:",
    `  Mode: ${logs.mode}`,
    `  Path: ${logs.activePath}`,
    `  Size: ${humanBytes(logs.totalSizeBytes)}`,
    `  Rotated files: ${logs.rotatedFiles.length}`,
    `  Rotation: ${humanBytes(logs.maxBytes)}, keep ${logs.retain}`,
  ];
  if (logs.error) lines.push(`  Error: ${logs.error}`);
  return lines;
}

function formatEnvSection(env: DoctorReport["env"]): string[] {
  const lines = ["", "Environment:"];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`  ${key}: ${value ?? "unset"}`);
  }
  return lines;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "Kesha Doctor",
    "",
    "Runtime:",
    `  Package: ${report.package.name} ${report.package.version}`,
    `  Bun: ${report.runtime.bunVersion}`,
    `  Platform: ${report.runtime.platform} ${report.runtime.arch}`,
    "",
    "Engine:",
    `  Binary: ${report.engine.path} (${formatEngineBinaryState(report.engine)})`,
    `  Version marker: ${report.engine.versionMarker ?? "missing"}`,
    `  Pinned version: ${report.engine.pinnedVersion}`,
    `  Version state: ${formatVersionState(report.engine)}`,
    `  Capabilities: ${formatCapabilities(report.engine)}`,
    "",
    ...formatCacheSection(report.cache),
    ...formatOptionalSection(report.optionalComponents),
    ...formatStatsSection(report.stats),
    ...formatDiagnosticLogsSection(report.diagnosticLogs),
    ...formatEnvSection(report.env),
  ];

  return `${lines.join("\n")}\n`;
}
