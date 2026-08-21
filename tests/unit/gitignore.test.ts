import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { REPO_ROOT } from "../helpers/repo";

// --no-index so the answer comes from the ignore rules alone, not from whether the file exists on
// disk or is tracked. A grep of the .gitignore text would also pass on a commented-out line;
// check-ignore is the only check that actually asks git.
function ignored(path: string): boolean {
  const probe = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", path], { cwd: REPO_ROOT });
  if (probe.status !== 0 && probe.status !== 1) {
    throw new Error(`git check-ignore failed for ${path}: ${probe.stderr?.toString() ?? probe.error}`);
  }
  return probe.status === 0;
}

test("the standalone conveyor's local profile stays out of the index", () => {
  expect(ignored("conveyor.config.json")).toBe(true);
});

// A sibling name that is not the exact profile filename must not be swept up by an over-broad
// pattern — the rule is one exact path, not a glob over every conveyor.config*.json.
test("a differently named file is not ignored by the profile rule", () => {
  expect(ignored("conveyor.config.example.json")).toBe(false);
});
