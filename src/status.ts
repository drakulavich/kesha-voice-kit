import { readdirSync, statSync } from "fs";
import { join } from "path";
import modelPlan from "../model-plan.json" with { type: "json" };
import {
  isEngineInstalled,
  getEngineBinPath,
  type EngineCapabilities,
} from "./engine";
import {
  CORRUPT_STATE,
  engineFunctionalHealth,
  NOT_FUNCTIONAL_STATE,
  type EngineFunctionalHealth,
} from "./engine-health";
import { cacheComponentPaths, isInsideDir } from "./cache-layout";
import { humanBytes } from "./format";
import { installHint } from "./install-hint";
import { log } from "./log";
import { packageVersion } from "./package-info";
import { keshaCacheDir } from "./paths";
import { isCoremlBackend } from "./fluid-asr-cache";
import {
  fluidExternalRoots,
  fluidExternalTotalBytes,
  type FluidExternalRoot,
} from "./fluid-roots";
import { dirSizeBytes } from "./diagnostic-paths";
import pc from "picocolors";

export function formatStatusLine(
  label: string,
  path: string | null,
  installed: boolean,
  missingLabel = "not installed",
): string {
  const status = installed ? pc.green("✓") : pc.red("✗");
  const value = installed ? path : missingLabel;
  return `  ${status} ${label}: ${value ?? ""}`;
}

export interface ShowStatusOptions {
  disk?: boolean;
  /** Every legacy FluidAudio root is home-relative; injecting the home makes `--disk` testable (#688). */
  homeDir?: string;
}

export interface StatusDiskComponent {
  label: string;
  sizeBytes: number;
}

export interface StatusDiskUsage {
  cachePath: string;
  components: StatusDiskComponent[];
  componentTotalBytes: number;
  /** The Kesha cache plus an engine installed outside it. */
  totalBytes: number;
  externalRoots: FluidExternalRoot[];
  externalTotalBytes: number;
  /** Everything Kesha put on disk, wherever it landed. */
  grandTotalBytes: number;
}

/**
 * Machine-readable `kesha status` payload (#647). Contract: every key is always
 * present — absent values are null (or `[]` for voices), never omitted, so a
 * consumer never distinguishes a missing key from a null value. `engine.installed`
 * reports only that a binary exists; usability additionally requires
 * `engine.capabilities` to be non-null.
 */
export interface StatusReport {
  cliVersion: string;
  engine: {
    installed: boolean;
    path: string;
    capabilities: EngineCapabilities | null;
  };
  voices: string[];
  runtime: { bun: string; platform: string; arch: string };
  modelMirror: string | null;
  hint: string | null;
  disk: StatusDiskUsage | null;
}

export async function collectStatus(options: ShowStatusOptions = {}): Promise<StatusReport> {
  const path = getEngineBinPath();
  const installed = isEngineInstalled();
  const health = installed ? await engineFunctionalHealth() : ({ status: "missing" } as const);
  const capabilities = health.status === "ok" ? health.capabilities : null;

  return {
    cliVersion: packageVersion,
    engine: { installed, path, capabilities },
    voices: installed ? listInstalledVoices() : [],
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    modelMirror: activeModelMirror(),
    hint: engineHint(path, health.status),
    // Absent engine means no disk walk, matching the human path (#647).
    disk:
      installed && options.disk
        ? collectDiskUsage(path, capabilities?.backend, options.homeDir)
        : null,
  };
}

/** An engine that runs but describes nothing needs the same repair as a missing one (#801). */
function engineHint(path: string, health: EngineFunctionalHealth["status"]): string | null {
  switch (health) {
    case "missing":
      return `Run \`${installHint()}\` to download the engine and models.`;
    case "mute":
      return `Engine at ${path} is ${NOT_FUNCTIONAL_STATE}`;
    case "unusable":
      return `Engine at ${path} is ${CORRUPT_STATE}`;
    default:
      return null;
  }
}

function logEngineCapabilities(caps: EngineCapabilities | null): void {
  if (caps) {
    log.info(formatStatusLine("Backend", caps.backend, true));
    log.info(formatStatusLine("Protocol", `v${caps.protocolVersion}`, true));
    log.info(formatStatusLine("Features", caps.features.join(", "), true));
  } else {
    log.info(formatStatusLine("Capabilities", null, false, "probe failed"));
  }
}

function logInstalledVoices(voices: string[]): void {
  if (voices.length === 0) return;
  log.info("TTS voices:");
  for (const v of voices) {
    log.info(`  ${v}`);
  }
  log.info("");
}

export function renderStatus(report: StatusReport): void {
  const { installed, path, capabilities } = report.engine;

  log.info("Engine:");
  log.info(formatStatusLine("Binary", installed ? path : null, installed));

  if (installed) {
    logEngineCapabilities(capabilities);
  }
  log.info("");

  log.info(formatStatusLine("Runtime", `Bun ${report.runtime.bun}`, true));
  log.info(
    formatStatusLine("Platform", `${report.runtime.platform} ${report.runtime.arch}`, true),
  );
  if (report.modelMirror) {
    log.info(formatStatusLine("Mirror", report.modelMirror, true));
  }
  log.info("");

  if (installed) {
    logInstalledVoices(report.voices);
    if (report.disk) showDiskUsage(report.disk);
  }

  if (report.hint) {
    log.warn(report.hint);
  }
}


function logDiskRows(rows: StatusDiskComponent[], total: number, componentTotal: number): void {
  const labelWidth = Math.max(...rows.map((r) => r.label.length), "Total".length);
  for (const r of rows) {
    const pad = " ".repeat(labelWidth - r.label.length + 2);
    log.info(`  ${r.label}:${pad}${humanBytes(r.sizeBytes)}`);
  }
  const totalPad = " ".repeat(labelWidth - "Total".length + 2);
  log.info(`  ${pc.bold("Total")}:${totalPad}${pc.bold(humanBytes(total))}`);
  if (total > componentTotal) {
    const other = total - componentTotal;
    log.info(pc.dim(`  (includes ${humanBytes(other)} of other cache files)`));
  }
}

function logExternalRoots(disk: StatusDiskUsage): void {
  if (disk.externalRoots.length === 0) return;
  log.info("");
  log.info("FluidAudio caches outside the Kesha cache:");
  for (const root of disk.externalRoots) {
    log.info(`  ${root.path}: ${humanBytes(root.sizeBytes)}`);
    for (const s of root.subsystems) {
      log.info(`    ${s.label}: ${humanBytes(s.sizeBytes)}`);
    }
    if (root.otherBytes > 0) {
      log.info(pc.dim(`    ${humanBytes(root.otherBytes)} not attributed to any subsystem above`));
    }
  }
  log.info(`  ${pc.bold("Grand total")}: ${pc.bold(humanBytes(disk.grandTotalBytes))}`);
}

function collectDiskUsage(binPath: string, backend?: string, homeDir?: string): StatusDiskUsage {
  const cache = keshaCacheDir();
  // Two levels up from the binary (`<cache>/engine/bin/`) so future engine-root siblings are counted.
  const engineDir = join(binPath, "..", "..");

  const components: StatusDiskComponent[] = [];
  for (const c of cacheComponentPaths(cache, engineDir, isCoremlBackend(backend))) {
    const sizeBytes = dirSizeBytes(c.path);
    if (sizeBytes > 0) components.push({ label: c.label, sizeBytes });
  }

  // Sum cache root + engine dir separately so `KESHA_ENGINE_BIN` overrides outside the cache are still counted.
  const cacheTotal = dirSizeBytes(cache);
  const engineOutsideCache = isInsideDir(engineDir, cache) ? 0 : dirSizeBytes(engineDir);
  const totalBytes = cacheTotal + engineOutsideCache;
  const externalRoots = fluidExternalRoots({ homeDir, cacheRoot: cache });
  const externalTotalBytes = fluidExternalTotalBytes(externalRoots);

  return {
    cachePath: cache,
    components,
    componentTotalBytes: components.reduce((n, c) => n + c.sizeBytes, 0),
    totalBytes,
    externalRoots,
    externalTotalBytes,
    grandTotalBytes: totalBytes + externalTotalBytes,
  };
}

function showDiskUsage(disk: StatusDiskUsage): void {
  if (disk.components.length === 0 && disk.externalRoots.length === 0) return;

  log.info(`Disk usage (${disk.cachePath}):`);
  logDiskRows(disk.components, disk.totalBytes, disk.componentTotalBytes);
  logExternalRoots(disk);
  log.info("");
  log.info(
    pc.dim(`  To reset cache: rm -rf ${disk.cachePath} — next \`kesha install\` re-downloads.`),
  );
  log.info("");
}

/** Returns the effective `KESHA_MODEL_MIRROR` URL (#121), trimmed; null when unset. Mirrors `model_mirror()` in `rust/src/models/download.rs`. */
export function activeModelMirror(): string | null {
  const raw = process.env.KESHA_MODEL_MIRROR ?? "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

function listInstalledVoices(): string[] {
  const cache = keshaCacheDir();
  const voices: string[] = [];
  try {
    const kokoro = readdirSync(join(cache, "models", "kokoro-82m", "voices"));
    for (const f of kokoro) {
      if (f.endsWith(".bin")) voices.push(`en-${f.replace(/\.bin$/, "")}`);
    }
  } catch {
    /* Kokoro not installed */
  }
  try {
    // Joined to `models/manifest.rs::VOSK_RU_FILES` through the plan, so a sixth entry needs no edit here (#1132).
    for (const { relPath } of modelPlan.voskRu) statSync(join(cache, relPath));
    for (const id of ["f01", "f02", "f03", "m01", "m02"]) {
      voices.push(`ru-vosk-${id}`);
    }
  } catch {
    /* Vosk not installed */
  }
  return voices.sort();
}
