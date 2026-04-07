#!/usr/bin/env bun
/**
 * Stage a file, commit, and push with retry.
 * Usage: bun commit-and-push.ts <file> [message]
 * Default message: "ci: update <file>"
 */

const file = process.argv[2];
if (!file) {
  console.error("Usage: bun commit-and-push.ts <file> [message]");
  process.exit(1);
}
const message = process.argv[3] ?? `ci: update ${file}`;

// Warn and skip if not on main
const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe" });
const currentBranch = branch.stdout.toString().trim();
if (currentBranch !== "main" && currentBranch !== "HEAD") {
  console.warn(`⚠️  Skipping commit — running on feature branch '${currentBranch}', not main`);
  process.exit(0);
}

function run(cmd: string[]): boolean {
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  return result.exitCode === 0;
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

if (!run(["git", "commit", "-m", message])) {
  console.error("Failed to commit");
  process.exit(1);
}
run(["git", "pull", "--rebase", "origin", "main"]);

if (!run(["git", "push"])) {
  run(["git", "pull", "--rebase", "origin", "main"]);
  if (!run(["git", "push"])) {
    console.error("Failed to push after retry");
    process.exit(1);
  }
}
