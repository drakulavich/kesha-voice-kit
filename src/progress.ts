import { log } from "./log";

const BAR_WIDTH = 20;

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatProgressBar(label: string, downloaded: number, total: number): string {
  const pct = Math.min(100, Math.floor((downloaded / total) * 100));
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `${label}  [${bar}] ${pct}%  ${formatBytes(downloaded)}/${formatBytes(total)}`;
}

export function createProgressBar(label: string, totalBytes: number): {
  update(downloadedBytes: number): void;
  finish(): void;
} {
  const isTTY = process.stderr.isTTY;

  if (!isTTY || totalBytes <= 0) {
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
  return {
    update(downloadedBytes: number) {
      current += downloadedBytes;
      const line = formatProgressBar(label, current, totalBytes);
      process.stderr.write(`\r${line}`);
    },
    finish() {
      const line = formatProgressBar(label, totalBytes, totalBytes);
      process.stderr.write(`\r${line}\n`);
    },
  };
}
