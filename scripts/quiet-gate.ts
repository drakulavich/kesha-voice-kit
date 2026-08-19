#!/usr/bin/env bun
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type QuietResult = { exitCode: number; log: string; logPath: string; durationMs: number };

/// Both streams share one file descriptor so the log reads in the order the command wrote it:
/// separate pipes reorder a failure's error relative to the output that followed it.
export async function runQuiet(argv: string[], directory = mkdtempSync(join(tmpdir(), "kesha-gate-"))): Promise<QuietResult> {
  const logPath = join(directory, "gate.log");
  const started = Date.now();
  const fd = openSync(logPath, "w");
  try {
    const process = Bun.spawn(argv, { stdout: fd, stderr: fd });
    const exitCode = await process.exited;
    closeSync(fd);
    return { exitCode, log: readFileSync(logPath, "utf8"), logPath, durationMs: Date.now() - started };
  } catch (error) {
    closeSync(fd);
    const message = `could not start ${argv[0]}: ${error instanceof Error ? error.message : String(error)}\n`;
    return { exitCode: 127, log: message, logPath, durationMs: Date.now() - started };
  }
}

function usage(message: string): never {
  console.error(`${message}\nusage: bun scripts/quiet-gate.ts <label> -- <command> [args...]`);
  process.exit(2);
}

function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const [label, separator, ...command] = process.argv.slice(2);
  if (!label) usage("a label is required");
  if (separator !== "--" || command.length === 0) usage("the command must follow a literal --");

  // A buffered gate shows nothing while it runs, which matters only to someone watching it.
  if (process.stderr.isTTY) process.stderr.write(`… ${label}\n`);
  const result = await runQuiet(command);
  if (result.exitCode === 0) {
    rmSync(result.logPath, { force: true });
    console.log(`✓ ${label} ${seconds(result.durationMs)}`);
    return;
  }
  process.stderr.write(result.log);
  process.stderr.write(`✗ ${label} failed (exit ${result.exitCode}) after ${seconds(result.durationMs)}; log kept at ${result.logPath}\n`);
  process.exit(result.exitCode);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`quiet-gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
