import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitReview } from "../../scripts/review-wait";

function logIn(directory: string, contents: string): string {
  const path = join(directory, "review-1086-deadbeef.log");
  writeFileSync(path, contents);
  return path;
}

describe("awaitReview", () => {
  test("returns the review once, rather than the caller re-reading a growing log", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kesha-review-wait-"));
    const path = logIn(directory, "P1: the guard is unpinned\n");
    writeFileSync(`${path}.status`, "0\n");

    await expect(awaitReview(path, { deadlineMs: 0, pollMs: 1 })).resolves.toEqual({
      state: "finished",
      reviewerExitCode: 0,
      review: "P1: the guard is unpinned\n",
    });
  });

  test("waits for the sentinel the reviewer writes when it exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kesha-review-wait-"));
    const path = logIn(directory, "partial");
    setTimeout(() => {
      writeFileSync(path, "complete\n");
      writeFileSync(`${path}.status`, "0\n");
    }, 30);

    const result = await awaitReview(path, { deadlineMs: 5000, pollMs: 5 });

    expect(result).toMatchObject({ state: "finished", review: "complete\n" });
  });

  // A reviewer that died owes the caller a review it will never write; reporting the log as a
  // finished review would send its truncated output to the pull request as findings.
  test("reports a reviewer that failed instead of passing its output off as findings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kesha-review-wait-"));
    const path = logIn(directory, "omc: command not found\n");
    writeFileSync(`${path}.status`, "127\n");

    const result = await awaitReview(path, { deadlineMs: 0, pollMs: 1 });

    expect(result).toMatchObject({ state: "failed", reviewerExitCode: 127 });
  });

  test("gives up at the deadline rather than blocking forever", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kesha-review-wait-"));
    const path = logIn(directory, "still thinking");

    await expect(awaitReview(path, { deadlineMs: 10, pollMs: 5 })).resolves.toMatchObject({ state: "waiting" });
  });

  test("refuses a log no review ever wrote, rather than waiting out the deadline on a typo", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kesha-review-wait-"));

    await expect(awaitReview(join(directory, "absent.log"), { deadlineMs: 10, pollMs: 5 })).rejects.toThrow("absent.log");
  });
});
