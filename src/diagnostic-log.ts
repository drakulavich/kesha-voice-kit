import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { log } from "./log";
import { packageVersion } from "./package-info";

const ACTIVE_LOG_FILE = "kesha.ndjson";
const STATE_FILE = "diagnostic-logs.json";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETAIN = 5;
const SAFE_LABEL = /^[A-Za-z0-9_.:/@+-]{1,120}$/;
const SAFE_EVENT = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;
const DISALLOWED_FIELD_NAME =
  /(?:path|file|filename|basename|message|text|transcript|stdout|stderr|env|token|secret|password|key|url|prompt|content|raw)/i;
const PATH_LIKE_VALUE =
  /(?:\/Users\/|\/home\/|\/tmp\/|\/private\/tmp\/|\/var\/folders\/|[A-Za-z]:\\|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:wav|ogg|m4a|mp3|flac)\b)/i;

export type DiagnosticLogValue = string | number | boolean | null;
export type DiagnosticLogFields = Record<string, DiagnosticLogValue>;

export interface DiagnosticLogConfig {
  enabled: boolean;
  maxBytes: number;
  retain: number;
}

export interface DiagnosticLogStatus extends DiagnosticLogConfig {
  dir: string;
  activePath: string;
  statePath: string;
  exists: boolean;
  activeSizeBytes: number;
  rotatedFiles: string[];
  totalSizeBytes: number;
}

interface DiagnosticLogOptions {
  now?: Date;
  pid?: number;
}

export function resolveDiagnosticLogDir(): string {
  if (process.env.KESHA_LOG_DIR) return process.env.KESHA_LOG_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Logs", "kesha");
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "kesha", "logs");
  }
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "kesha", "logs");
}

export function resolveDiagnosticLogPath(): string {
  return join(resolveDiagnosticLogDir(), ACTIVE_LOG_FILE);
}

function resolveStatePath(): string {
  return join(resolveDiagnosticLogDir(), STATE_FILE);
}

function defaultConfig(): DiagnosticLogConfig {
  return {
    enabled: false,
    maxBytes: DEFAULT_MAX_BYTES,
    retain: DEFAULT_RETAIN,
  };
}

function readConfig(): DiagnosticLogConfig {
  const statePath = resolveStatePath();
  if (!existsSync(statePath)) return defaultConfig();
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<DiagnosticLogConfig>;
    return {
      enabled: parsed.enabled === true,
      maxBytes: positiveInt(parsed.maxBytes, DEFAULT_MAX_BYTES),
      retain: positiveInt(parsed.retain, DEFAULT_RETAIN),
    };
  } catch {
    return defaultConfig();
  }
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function writeConfig(config: DiagnosticLogConfig): void {
  const statePath = resolveStatePath();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(config, null, 2)}\n`);
}

export function enableDiagnosticLogs(): DiagnosticLogStatus {
  writeConfig({ ...readConfig(), enabled: true });
  return getDiagnosticLogStatus();
}

export function disableDiagnosticLogs(): DiagnosticLogStatus {
  writeConfig({ ...readConfig(), enabled: false });
  return getDiagnosticLogStatus();
}

export function getDiagnosticLogStatus(): DiagnosticLogStatus {
  const dir = resolveDiagnosticLogDir();
  const activePath = join(dir, ACTIVE_LOG_FILE);
  const statePath = join(dir, STATE_FILE);
  const config = readConfig();
  const rotatedFiles = listRotatedLogFiles(dir);
  const activeSizeBytes = fileSize(activePath);
  const rotatedSizeBytes = rotatedFiles.reduce((sum, file) => sum + fileSize(join(dir, file)), 0);
  return {
    ...config,
    dir,
    activePath,
    statePath,
    exists: existsSync(activePath),
    activeSizeBytes,
    rotatedFiles,
    totalSizeBytes: activeSizeBytes + rotatedSizeBytes,
  };
}

function listRotatedLogFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^kesha\.\d+\.ndjson$/.test(name))
    .sort((a, b) => rotationIndex(a) - rotationIndex(b));
}

function rotationIndex(name: string): number {
  const match = /^kesha\.(\d+)\.ndjson$/.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function resetDiagnosticLogs(): { deleted: number; bytes: number; dir: string } {
  const dir = resolveDiagnosticLogDir();
  const files = [ACTIVE_LOG_FILE, ...listRotatedLogFiles(dir)];
  let deleted = 0;
  let bytes = 0;
  for (const file of files) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    bytes += fileSize(path);
    rmSync(path, { force: true });
    deleted++;
  }
  return { deleted, bytes, dir };
}

export function writeDiagnosticEvent(event: string, fields: DiagnosticLogFields = {}): boolean {
  const status = getDiagnosticLogStatus();
  if (!status.enabled) return false;
  try {
    const line = buildDiagnosticLogLine(event, fields);
    mkdirSync(status.dir, { recursive: true });
    rotateIfNeeded(status.activePath, line.byteLength, status.maxBytes, status.retain);
    writeFileSync(status.activePath, line, { flag: "a" });
    return true;
  } catch (err) {
    log.debug(`diagnostic log event dropped: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function buildDiagnosticLogLine(
  event: string,
  fields: DiagnosticLogFields = {},
  options: DiagnosticLogOptions = {},
): Uint8Array {
  validateEventName(event);
  const payload: Record<string, DiagnosticLogValue> = {
    ts: (options.now ?? new Date()).toISOString(),
    level: "info",
    event,
    app_version: packageVersion,
    pid: options.pid ?? process.pid,
  };
  for (const [key, value] of Object.entries(fields)) {
    validateField(key, value);
    payload[key] = value;
  }
  return new TextEncoder().encode(`${JSON.stringify(payload)}\n`);
}

function validateEventName(event: string): void {
  if (!SAFE_EVENT.test(event)) {
    throw new Error(`unsafe diagnostic event name: ${event}`);
  }
}

function validateField(key: string, value: DiagnosticLogValue): void {
  if (!SAFE_LABEL.test(key) || DISALLOWED_FIELD_NAME.test(key)) {
    throw new Error(`unsafe diagnostic field name: ${key}`);
  }
  if (typeof value === "string") {
    if (!SAFE_LABEL.test(value) || PATH_LIKE_VALUE.test(value)) {
      throw new Error(`unsafe diagnostic string field: ${key}`);
    }
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`unsafe diagnostic numeric field: ${key}`);
  }
}

function rotateIfNeeded(activePath: string, nextBytes: number, maxBytes: number, retain: number): void {
  if (fileSize(activePath) + nextBytes <= maxBytes) return;
  const dir = dirname(activePath);
  rmSync(join(dir, `kesha.${retain}.ndjson`), { force: true });
  for (let i = retain - 1; i >= 1; i--) {
    const from = join(dir, `kesha.${i}.ndjson`);
    if (existsSync(from)) renameSync(from, join(dir, `kesha.${i + 1}.ndjson`));
  }
  if (existsSync(activePath)) renameSync(activePath, join(dir, "kesha.1.ndjson"));
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
