import { copyFileSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { errorMessage } from "./error-utils";
import { log } from "./log";

const BAR_WIDTH = 20;
const DEFAULT_ESTIMATED_PROGRESS_MS = 30 * 60 * 1000;

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function bar(pct: number): string {
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

export function formatProgressBar(label: string, downloaded: number, total: number): string {
  const pct = total <= 0 ? 0 : Math.min(100, Math.floor((downloaded / total) * 100));
  return `${label}  [${bar(pct)}] ${pct}%  ${formatBytes(downloaded)}/${formatBytes(total)}`;
}

export function formatPercentProgress(label: string, percent: number): string {
  const pct = Math.max(0, Math.min(100, Math.floor(percent)));
  return `${label}  [${bar(pct)}] ${pct}%`;
}

/**
 * Time-based estimate for work that reports no progress of its own: 0 before it starts,
 * then 1..99 — never 100, which only `finish` may claim. Exported for the test.
 */
export function estimatePercent(elapsedMs: number, estimatedTotalMs: number): number {
  if (elapsedMs <= 0) return 0;
  const targetMs = Math.max(1, estimatedTotalMs);
  return Math.max(1, Math.min(99, Math.floor((elapsedMs / targetMs) * 99)));
}

export function createPercentProgress(
  label: string,
  options: { estimatedTotalMs?: number; intervalMs?: number } = {},
): {
  finish(finalLabel: string): void;
  interrupt(writeLine: () => void): void;
  stop(): void;
} {
  const isTTY = process.stderr.isTTY;

  if (!isTTY) {
    process.stderr.write(`${formatPercentProgress(label, 0)}\n`);
    return {
      finish(finalLabel: string) {
        process.stderr.write(`${formatPercentProgress(finalLabel, 100)}\n`);
      },
      interrupt(writeLine: () => void) {
        writeLine();
      },
      stop() {},
    };
  }

  const intervalMs = options.intervalMs ?? 250;
  const estimatedTotalMs = options.estimatedTotalMs ?? DEFAULT_ESTIMATED_PROGRESS_MS;
  const startedAt = performance.now();
  let lastLineLength = 0;
  let timer: Timer | undefined;
  let stopped = false;
  let firstRender = true;

  const render = () => {
    if (stopped) return;
    const percent = firstRender ? 0 : estimatePercent(performance.now() - startedAt, estimatedTotalMs);
    firstRender = false;
    const line = formatPercentProgress(label, percent);
    lastLineLength = line.length;
    process.stderr.write(`\r${line}`);
  };

  const clearLine = (stopTimer: boolean) => {
    if (stopTimer) stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (lastLineLength > 0) {
      process.stderr.write(`\r${" ".repeat(lastLineLength)}\r`);
      lastLineLength = 0;
    }
  };

  render();
  timer = setInterval(render, intervalMs);

  return {
    finish(finalLabel: string) {
      clearLine(true);
      process.stderr.write(`${formatPercentProgress(finalLabel, 100)}\n`);
    },
    interrupt(writeLine: () => void) {
      if (stopped) {
        writeLine();
        return;
      }
      clearLine(false);
      writeLine();
      render();
      timer = setInterval(render, intervalMs);
    },
    stop() {
      clearLine(true);
    },
  };
}

type SinkWrite = ReturnType<Bun.FileSink["write"]>;

/**
 * Waits for the sink whenever a write did not complete inline.
 *
 * Bun's FileSink reports a pending write as a Promise and backpressure as the negative
 * sentinel `-(bytes + 1)`; discarding either buffers the whole download in memory instead
 * of throttling to disk speed, which for the engine is ~63 MB and for the Vosk voice ~937 MB
 * (#669). Exported for the test — the sentinel is not reproducible on demand.
 */
export async function applyBackpressure(
  writer: Pick<Bun.FileSink, "flush">,
  written: SinkWrite,
): Promise<void> {
  if (typeof written !== "number") {
    await written;
    return;
  }
  if (written < 0) await writer.flush();
}

/**
 * Age threshold and platform gate mirror `rust/src/models/download.rs::cleanup_orphan_staging`: a
 * concurrent installer's staging file keeps a fresh mtime while bytes stream into it, and
 * Windows leaves last-write time stale while a handle is open, so an in-flight download
 * there could not be told apart from an orphan.
 */
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

/** A Ctrl-C kills the process before any cleanup runs, so last run's staging file is swept by the next one (#770). */
function sweepStagingFiles(destPath: string): void {
  if (process.platform === "win32") return;
  const dir = dirname(destPath);
  const prefix = `${basename(destPath)}.part.`;
  const cutoffMs = Date.now() - STALE_STAGING_MS;

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    log.debug(`Could not scan ${dir} for orphaned download staging: ${errorMessage(err)}`);
    return;
  }

  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs > cutoffMs) continue;
      rmSync(path, { force: true });
      log.debug(`Cleaned up orphaned download staging: ${name}`);
    } catch (err) {
      log.debug(`Could not sweep orphaned download staging ${name}: ${errorMessage(err)}`);
    }
  }
}

/** Windows refuses `rename` onto a destination another handle still holds; POSIX overwrites. */
function publishStaging(stagingPath: string, destPath: string): void {
  try {
    renameSync(stagingPath, destPath);
  } catch (err) {
    if (process.platform !== "win32") throw err;
    copyFileSync(stagingPath, destPath);
    rmSync(stagingPath, { force: true });
  }
}

/** The pid alone would collide between two concurrent calls in one process, which then share a staging file. */
let stagingSeq = 0;

/**
 * Downloads into a sibling `.part.<pid>.<n>` file and renames it into place, so an
 * interrupted download can never leave a truncated binary at `destPath` (#770). Mirrors the
 * staging `rust/src/models/download.rs::write_verified` already does for model files. Staging beside
 * the destination keeps the rename within one filesystem, where it is atomic.
 */
export async function streamResponseToFile(
  res: Response,
  destPath: string,
  label: string,
): Promise<number> {
  if (!res.body) {
    throw new Error(
      `Download failed: empty response for ${label}\n  Fix: Try again — the server may be temporarily unavailable`,
    );
  }

  const totalBytes = Number(res.headers.get("content-length") || 0);
  const progress = createProgressBar(label, totalBytes);

  sweepStagingFiles(destPath);
  const stagingPath = `${destPath}.part.${process.pid}.${stagingSeq++}`;
  const writer = Bun.file(stagingPath).writer();
  let bytes = 0;
  try {
    try {
      for await (const chunk of res.body) {
        await applyBackpressure(writer, writer.write(chunk));
        bytes += chunk.length;
        progress.update(chunk.length);
      }
    } finally {
      // Must await: an open write handle makes the freshly-downloaded engine unspawnable — EBUSY on Windows, ETXTBSY on Linux.
      await writer.end();
    }
    publishStaging(stagingPath, destPath);
  } catch (err) {
    rmSync(stagingPath, { force: true });
    throw err;
  }

  progress.finish();
  return bytes;
}

export function createProgressBar(label: string, totalBytes: number): {
  update(downloadedBytes: number): void;
  finish(): void;
} {
  const isTTY = process.stderr.isTTY;

  // A garbage `Content-Length` parses to NaN, which is not `<= 0`, and `NaN === lastPct` never coalesces.
  if (!isTTY || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    const sizeInfo = totalBytes > 0 ? ` (${formatBytes(totalBytes)})` : "";
    log.progress(`Downloading ${label}${sizeInfo}...`);
    return {
      update() {},
      finish() {
        log.success(`Downloaded ${label} ✓`);
      },
    };
  }

  let current = 0;
  let lastPct = -1;
  return {
    update(downloadedBytes: number) {
      current += downloadedBytes;
      const pct = Math.floor((current / totalBytes) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      const line = formatProgressBar(label, current, totalBytes);
      process.stderr.write(`\r${line}`);
    },
    finish() {
      const line = formatProgressBar(label, totalBytes, totalBytes);
      process.stderr.write(`\r${line}\n`);
    },
  };
}
