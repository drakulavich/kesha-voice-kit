import { readdirSync, statSync } from "fs";
import { join } from "path";
import {
  isEngineInstalled,
  getEngineBinPath,
  getEngineCapabilities,
  type EngineCapabilities,
} from "./engine";
import { cacheComponentPaths, isInsideDir } from "./cache-layout";
import { humanBytes } from "./format";
import { installHint } from "./install-hint";
import { log } from "./log";
import { packageVersion } from "./package-info";
import { keshaCacheDir } from "./paths";
import { fluidKokoroCacheInfo } from "./fluid-kokoro-cache";
import { fluidAsrCacheInfo, isCoremlBackend } from "./fluid-asr-cache";
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
}

export interface StatusDiskComponent {
  label: string;
  sizeBytes: number;
}

export interface StatusDiskUsage {
  cachePath: string;
  components: StatusDiskComponent[];
  componentTotalBytes: number;
  totalBytes: number;
  fluidKokoro: { path: string; sizeBytes: number } | null;
  fluidAsr: { path: string; sizeBytes: number } | null;
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
  const capabilities = installed ? await getEngineCapabilities().catch(() => null) : null;

  return {
    cliVersion: packageVersion,
    engine: { installed, path, capabilities },
    voices: installed ? listInstalledVoices() : [],
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    modelMirror: activeModelMirror(),
    hint: installed
      ? null
      : `Run \`${installHint()}\` to download the engine and models.`,
    // Absent engine means no disk walk, matching the human path (#647).
    disk: installed && options.disk ? collectDiskUsage(path, capabilities?.backend) : null,
  };
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

function logExternalCaches(disk: StatusDiskUsage): void {
  if (!disk.fluidKokoro && !disk.fluidAsr) return;
  log.info("");
  log.info(`External caches (not included in Kesha total):`);
  if (disk.fluidAsr) {
    log.info(`  FluidAudio ASR:    ${humanBytes(disk.fluidAsr.sizeBytes)} (${disk.fluidAsr.path})`);
  }
  if (disk.fluidKokoro) {
    log.info(
      `  FluidAudio Kokoro: ${humanBytes(disk.fluidKokoro.sizeBytes)} (${disk.fluidKokoro.path})`,
    );
  }
}

function collectDiskUsage(binPath: string, backend?: string): StatusDiskUsage {
  const cache = keshaCacheDir();
  // Two levels up from the binary (`<cache>/engine/bin/`) so future engine-root siblings are counted.
  const engineDir = join(binPath, "..", "..");
  const coreml = isCoremlBackend(backend);

  const components: StatusDiskComponent[] = [];
  for (const c of cacheComponentPaths(cache, engineDir, coreml)) {
    const sizeBytes = dirSizeBytes(c.path);
    if (sizeBytes > 0) components.push({ label: c.label, sizeBytes });
  }

  // Sum cache root + engine dir separately so `KESHA_ENGINE_BIN` overrides outside the cache are still counted.
  const cacheTotal = dirSizeBytes(cache);
  const engineOutsideCache = isInsideDir(engineDir, cache) ? 0 : dirSizeBytes(engineDir);
  const fluidKokoro = fluidKokoroCacheInfo();
  // Only walked when it is the backend in play; otherwise the size is computed and dropped.
  const fluidAsr = coreml ? fluidAsrCacheInfo() : null;

  return {
    cachePath: cache,
    components,
    componentTotalBytes: components.reduce((n, c) => n + c.sizeBytes, 0),
    totalBytes: cacheTotal + engineOutsideCache,
    fluidKokoro:
      fluidKokoro.exists && fluidKokoro.sizeBytes > 0
        ? { path: fluidKokoro.path, sizeBytes: fluidKokoro.sizeBytes }
        : null,
    // Gate on readiness, not size, so a partial bundle is not shown as a present
    // cache while doctor reports it missing.
    fluidAsr:
      fluidAsr?.exists && fluidAsr.sizeBytes > 0
        ? { path: fluidAsr.path, sizeBytes: fluidAsr.sizeBytes }
        : null,
  };
}

function showDiskUsage(disk: StatusDiskUsage): void {
  if (disk.components.length === 0) return;

  log.info(`Disk usage (${disk.cachePath}):`);
  logDiskRows(disk.components, disk.totalBytes, disk.componentTotalBytes);
  logExternalCaches(disk);
  log.info("");
  log.info(
    pc.dim(`  To reset cache: rm -rf ${disk.cachePath} — next \`kesha install\` re-downloads.`),
  );
  log.info("");
}

/** Returns the effective `KESHA_MODEL_MIRROR` URL (#121), trimmed; null when unset. Mirrors `model_mirror()` in `rust/src/models.rs`. */
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
    // Mirror models::is_vosk_ru_cached — both files required to avoid advertising a partial install.
    statSync(join(cache, "models", "vosk-ru", "model.onnx"));
    statSync(join(cache, "models", "vosk-ru", "bert", "model.onnx"));
    for (const id of ["f01", "f02", "f03", "m01", "m02"]) {
      voices.push(`ru-vosk-${id}`);
    }
  } catch {
    /* Vosk not installed */
  }
  return voices.sort();
}
