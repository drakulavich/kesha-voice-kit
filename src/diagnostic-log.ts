import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { log } from "./log";
import { packageVersion } from "./package-info";

const ACTIVE_LOG_FILE = "kesha.ndjson";
const STATE_FILE = "diagnostic-logs.json";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETAIN = 5;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const SAFE_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_STRING_VALUE = /^[A-Za-z0-9_.@+-]{1,120}$/;
const SAFE_EVENT = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;
const DISALLOWED_FIELD_NAME =
  /(?:path|file|filename|basename|message|text|transcript|stdout|stderr|env|token|secret|password|key|url|prompt|content|raw)/i;
const UNSAFE_STRING_VALUE =
  /(?:[\\/]|^[A-Za-z][A-Za-z0-9+.-]*:|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:aac|aiff?|caf|flac|m4a|m4v|mov|mp3|mp4|ogg|opus|wav|webm|wma)\b|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b)/i;
const RESERVED_FIELD_NAMES = new Set(["ts", "level", "event", "app_version", "pid"]);

export type DiagnosticLogValue = string | number | boolean | null;
export type DiagnosticLogFields = Record<string, DiagnosticLogValue>;
export type DiagnosticLogMode = "off" | "on" | "retain-on-failure";
export type DiagnosticSessionStatus = "success" | "failed";

export interface DiagnosticLogConfig {
  mode: DiagnosticLogMode;
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

export interface DiagnosticLogTail {
  path: string;
  sizeBytes: number;
  truncated: boolean;
  contents: string;
}

interface DiagnosticLogOptions {
  now?: Date;
  pid?: number;
}

export interface DiagnosticLogSession {
  event(event: string, fields?: DiagnosticLogFields): boolean;
  finish(status: DiagnosticSessionStatus): boolean;
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
    mode: "retain-on-failure",
    maxBytes: DEFAULT_MAX_BYTES,
    retain: DEFAULT_RETAIN,
  };
}

function readConfig(): DiagnosticLogConfig {
  const statePath = resolveStatePath();
  if (!existsSync(statePath)) return defaultConfig();
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<DiagnosticLogConfig>;
    const parsedMode = parseMode(parsed.mode);
    return {
      mode: parsedMode ?? defaultConfig().mode,
      maxBytes: positiveInt(parsed.maxBytes, DEFAULT_MAX_BYTES),
      retain: positiveInt(parsed.retain, DEFAULT_RETAIN),
    };
  } catch {
    return defaultConfig();
  }
}

export function parseDiagnosticLogMode(value: string): DiagnosticLogMode | null {
  return parseMode(value);
}

function parseMode(value: unknown): DiagnosticLogMode | null {
  return value === "off" || value === "on" || value === "retain-on-failure" ? value : null;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function writeConfig(config: DiagnosticLogConfig): void {
  const statePath = resolveStatePath();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(config, null, 2)}\n`);
}

export function setDiagnosticLogMode(mode: DiagnosticLogMode): DiagnosticLogStatus {
  writeConfig({ ...readConfig(), mode });
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

export function readDiagnosticLogTail(maxBytes = DEFAULT_TAIL_BYTES): DiagnosticLogTail | null {
  const path = resolveDiagnosticLogPath();
  if (!existsSync(path)) return null;
  const sizeBytes = fileSize(path);
  if (sizeBytes === 0) {
    return { path, sizeBytes, truncated: false, contents: "" };
  }

  const bytesToRead = Math.min(maxBytes, sizeBytes);
  const offset = sizeBytes - bytesToRead;
  const buffer = new Uint8Array(bytesToRead);
  const fd = openSync(path, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
  } finally {
    closeSync(fd);
  }

  let contents = new TextDecoder().decode(buffer.subarray(0, bytesRead));
  const truncated = offset > 0;
  if (truncated) {
    const firstLineBreak = contents.indexOf("\n");
    contents = firstLineBreak === -1 ? "" : contents.slice(firstLineBreak + 1);
  }
  return { path, sizeBytes, truncated, contents };
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

export function createDiagnosticLogSession(): DiagnosticLogSession {
  const status = getDiagnosticLogStatus();
  const buffered: Uint8Array[] = [];
  let finished = false;
  if (status.mode === "off") return noopSession();

  return {
    event(event: string, fields: DiagnosticLogFields = {}): boolean {
      if (finished) return false;
      try {
        const line = buildDiagnosticLogLine(event, fields);
        if (status.mode === "retain-on-failure") {
          buffered.push(line);
          return true;
        }
        appendDiagnosticLogLine(line, status);
        return true;
      } catch (err) {
        log.debug(`diagnostic log event dropped: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },
    finish(sessionStatus: DiagnosticSessionStatus): boolean {
      if (finished) return false;
      finished = true;
      if (status.mode !== "retain-on-failure" || sessionStatus !== "failed" || buffered.length === 0) {
        buffered.length = 0;
        return false;
      }
      const flushStatus = getDiagnosticLogStatus();
      if (flushStatus.mode === "off") {
        buffered.length = 0;
        return false;
      }
      try {
        for (const line of buffered) appendDiagnosticLogLine(line, flushStatus);
        return true;
      } finally {
        buffered.length = 0;
      }
    },
  };
}

function noopSession(): DiagnosticLogSession {
  return {
    event: () => false,
    finish: () => false,
  };
}

function appendDiagnosticLogLine(line: Uint8Array, status: DiagnosticLogStatus): void {
  mkdirSync(status.dir, { recursive: true });
  rotateIfNeeded(status.activePath, line.byteLength, status.maxBytes, status.retain);
  writeFileSync(status.activePath, line, { flag: "a" });
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
  if (RESERVED_FIELD_NAMES.has(key) || !SAFE_FIELD_NAME.test(key) || DISALLOWED_FIELD_NAME.test(key)) {
    throw new Error(`unsafe diagnostic field name: ${key}`);
  }
  if (typeof value === "string") {
    if (!SAFE_STRING_VALUE.test(value) || UNSAFE_STRING_VALUE.test(value)) {
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
