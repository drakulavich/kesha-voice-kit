import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDir } from "../helpers/temp-dir";

const SCRIPT = resolve(import.meta.dir, "../../scripts/review.ts");
const URL = "https://github.com/o/r/pull/7#issuecomment-1";
const VERDICT_REVIEWER = `SECRET=abc123 sh -c 'cat >/dev/null; printf "Looks fine.\\n\\nVerdict: Approve\\n"'`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr view")
    [ -n "$FAKE_GH_NO_PR" ] && { echo 'no pull requests found for branch "feat"' >&2; exit 1; }
    printf '{"number":7,"headRefOid":"%s","baseRefName":"main","baseRefOid":"%s","headRefName":"feat"}\\n' "$FAKE_SHA" "$FAKE_SHA" ;;
  "pr comment") cp "$5" "$FAKE_POSTED"; echo "${URL}" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 9 ;;
esac
`;

let repo: string;
let bin: string;
let sha: string;

function git(...args: string[]): string {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

beforeAll(() => {
  repo = tempDir("review-launch-repo-");
  bin = tempDir("review-launch-bin-");
  git("init", "--quiet");
  git("commit", "--quiet", "--allow-empty", "-m", "base");
  sha = git("rev-parse", "HEAD");
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
});

function review(reviewer: string, extraEnv: Record<string, string> = {}) {
  const posted = join(tempDir("review-launch-post-"), "comment.md");
  const run = Bun.spawnSync(["bun", SCRIPT, "the launcher posts one comment"], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KESHA_REVIEWER: reviewer, FAKE_SHA: sha, FAKE_POSTED: posted, ...extraEnv },
  });
  return {
    code: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
    comment: existsSync(posted) ? readFileSync(posted, "utf8") : undefined,
  };
}

describe("just review against a stubbed gh", () => {
  test("posts one comment headed with the full head SHA and prints its URL", () => {
    const result = review(VERDICT_REVIEWER);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(URL);
    expect(result.comment?.split("\n")[0]).toBe(`### Adversarial review of #7 at ${sha}`);
    expect(result.comment).toContain("Verdict: Approve");
  });

  test("runs an override that starts with an environment assignment and keeps it out of the comment", () => {
    const result = review(VERDICT_REVIEWER);
    expect(result.code).toBe(0);
    expect(result.comment).not.toContain("abc123");
  });

  test("refuses with exit 2 and posts nothing when the branch has no PR", () => {
    const result = review(VERDICT_REVIEWER, { FAKE_GH_NO_PR: "1" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no pull request for this branch");
    expect(result.comment).toBeUndefined();
  });

  test("fails and posts nothing when the review has no verdict line", () => {
    const result = review(`sh -c 'cat >/dev/null; echo "still thinking"'`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Verdict:");
    expect(result.comment).toBeUndefined();
  });
});
