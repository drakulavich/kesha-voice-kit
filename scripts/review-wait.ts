#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";

export type ReviewState =
  | { state: "finished"; reviewerExitCode: number; review: string }
  | { state: "failed"; reviewerExitCode: number; review: string }
  | { state: "waiting" };

export type WaitOptions = { deadlineMs?: number; pollMs?: number };

const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/// `just review` detaches, so the only honest completion signal is the sentinel its subshell writes
/// after the reviewer exits. Polling the log itself reports a half-written review as a finished one.
export async function awaitReview(logPath: string, options: WaitOptions = {}): Promise<ReviewState> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pollMs = options.pollMs ?? 2000;
  if (!existsSync(logPath)) throw new Error(`no review log at ${logPath} — launch one with: just review "<claim>"`);
  const started = Date.now();
  const sentinel = `${logPath}.status`;
  for (;;) {
    if (existsSync(sentinel)) {
      const reviewerExitCode = Number.parseInt(readFileSync(sentinel, "utf8").trim(), 10);
      const review = readFileSync(logPath, "utf8");
      return reviewerExitCode === 0 ? { state: "finished", reviewerExitCode, review } : { state: "failed", reviewerExitCode, review };
    }
    if (Date.now() - started >= deadlineMs) return { state: "waiting" };
    await sleep(pollMs);
  }
}

function usage(message: string): never {
  console.error(`${message}\nusage: bun scripts/review-wait.ts <log> [--deadline-minutes N]`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [logPath, flag, minutes] = process.argv.slice(2);
  if (!logPath) usage("a review log path is required");
  if (flag !== undefined && flag !== "--deadline-minutes") usage(`unknown argument '${flag}'`);
  if (flag === "--deadline-minutes" && !/^[1-9]\d*$/.test(minutes ?? "")) usage("--deadline-minutes needs a positive integer");

  const result = await awaitReview(logPath, minutes ? { deadlineMs: Number(minutes) * 60 * 1000 } : {});
  if (result.state === "waiting") {
    console.error(`still reviewing after the deadline; it is still running — re-run: bun scripts/review-wait.ts ${logPath}`);
    process.exit(3);
  }
  console.log(result.review);
  if (result.state === "failed") {
    console.error(`the reviewer exited ${result.reviewerExitCode}; the output above is not a review`);
    process.exit(3);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`review-wait: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
