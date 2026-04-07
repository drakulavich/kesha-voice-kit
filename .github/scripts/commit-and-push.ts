#!/usr/bin/env bun
/**
 * Stage a file, commit on a timestamped branch, and open a PR.
 * Usage: bun commit-and-push.ts <file> [message]
 * Default message: "ci: update <file>"
 *
 * Respects branch protection by never pushing directly to main.
 */

const file = process.argv[2];
if (!file) {
  console.error("Usage: bun commit-and-push.ts <file> [message]");
  process.exit(1);
}
const message = process.argv[3] ?? `ci: update ${file}`;

function run(cmd: string[], opts?: { stdout?: "pipe" | "inherit" }): { ok: boolean; stdout: string } {
  const result = Bun.spawnSync(cmd, { stdout: opts?.stdout ?? "inherit", stderr: "inherit" });
  return { ok: result.exitCode === 0, stdout: result.stdout?.toString().trim() ?? "" };
}

run(["git", "config", "user.name", "github-actions[bot]"]);
run(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
run(["git", "add", file]);

// Check if there are staged changes
const diff = Bun.spawnSync(["git", "diff", "--cached", "--quiet"]);
if (diff.exitCode === 0) {
  console.log("No changes to commit");
  process.exit(0);
}

// Create a timestamped branch
const timestamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const branch = `ci/update-${file.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${timestamp}`;

if (!run(["git", "checkout", "-b", branch]).ok) {
  console.error(`Failed to create branch ${branch}`);
  process.exit(1);
}

if (!run(["git", "commit", "-m", message]).ok) {
  console.error("Failed to commit");
  process.exit(1);
}

if (!run(["git", "push", "-u", "origin", branch]).ok) {
  console.error("Failed to push branch");
  process.exit(1);
}

// Open a PR
const { ok, stdout } = run(["gh", "pr", "create", "--title", message, "--body", "Automated benchmark update from CI.", "--base", "main"], { stdout: "pipe" });
if (!ok) {
  console.error("Failed to create PR");
  process.exit(1);
}

console.log(`PR created: ${stdout}`);
