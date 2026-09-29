#!/usr/bin/env bun
// A reviewer, KESHA_REVIEWER included, reads the prompt on stdin and prints only the review on stdout: stdout is what gets posted.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FULL_SHA = /^[0-9a-f]{40}$/;
const LOG_DIR = ".reviews";
const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;
const DEFAULT_REVIEWER = ["codex", "exec", "--model", "gpt-6-luna", "--sandbox", "read-only"];

export type Target = { pr: number; head: string; base: string; branch: string };
export type Reviewer = { label: string; argv: string[]; binary: string };

function requireFullSha(head: string): void {
  if (!FULL_SHA.test(head)) throw new Error(`the head must be a full 40-hex SHA, got '${head}'`);
}

export function claimFrom(args: string[]): string {
  const claim = args.join(" ").trim();
  if (claim === "") throw new Error('review needs a claim to prove or refute: just review "<claim>"');
  return claim;
}

export function buildPrompt({ pr, head, base, branch, claim }: Target & { claim: string }): string {
  requireFullSha(head);
  return `Adversarial review of pull request #${pr} at head ${head} (branch ${branch} against ${base}).

Prove or refute this claim, and say which assertion fires if it is wrong:
${claim}

Scope: the changes in \`git diff origin/${base}...${head}\`. Read the surrounding code where the diff depends on it.

Where running something settles a question, run it rather than settling it by reading. If you still agree
with the claim after examining it, say so plainly. If the diff touches tests, say whether any existing
assertion was changed, deleted or renamed, and whether each change is justified or re-points a pin at
broken output.

Review along five axes: correctness, readability, architecture, security, performance.
Label every finding Critical, Required, Optional, Nit or FYI, and cite it as file:line.
Every Critical or Required finding says how to show it fails: the command, test or input that exposes it.

End the answer with exactly one line: \`Verdict: Approve\` or \`Verdict: Request changes\`.
`;
}

export function commentBody({ pr, head, claim, reviewer, review }: { pr: number; head: string; claim: string; reviewer: string; review: string }): string {
  requireFullSha(head);
  return `### Adversarial review of #${pr} at ${head}\n\nClaim: ${claim}\nReviewer: \`${reviewer}\`\n\n${review.trim()}\n`;
}

export function reviewerCommand(env: Record<string, string | undefined>): Reviewer {
  const custom = env.KESHA_REVIEWER?.trim();
  if (custom) return { label: custom, argv: ["sh", "-c", custom], binary: custom.split(/\s+/)[0]! };
  return { label: DEFAULT_REVIEWER.join(" "), argv: [...DEFAULT_REVIEWER, "--color", "never", "-"], binary: "codex" };
}

function refuse(message: string): never {
  console.error(`refusing: ${message}`);
  process.exit(EXIT_REFUSED);
}

function fail(message: string): never {
  console.error(`review failed: ${message}`);
  process.exit(EXIT_FAILED);
}

function run(argv: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function resolveTarget(): Target {
  const view = run(["gh", "pr", "view", "--json", "number,headRefOid,baseRefName,headRefName"]);
  if (view.code !== 0) refuse(`no pull request for this branch (${view.stderr.trim()}); open it first with gh pr create`);
  const pr = JSON.parse(view.stdout) as { number: number; headRefOid: string; baseRefName: string; headRefName: string };
  const local = run(["git", "rev-parse", "HEAD"]).stdout.trim();
  if (local !== pr.headRefOid) {
    refuse(`local HEAD ${local} is not the PR head ${pr.headRefOid}; push or pull so the reviewer reads what the PR shows`);
  }
  return { pr: pr.number, head: pr.headRefOid, base: pr.baseRefName, branch: pr.headRefName };
}

async function main(): Promise<void> {
  let claim: string;
  try {
    claim = claimFrom(process.argv.slice(2));
  } catch (error) {
    refuse((error as Error).message);
  }
  const reviewer = reviewerCommand(process.env);
  const found = reviewer.binary.includes("/") ? existsSync(reviewer.binary) : Bun.which(reviewer.binary) !== null;
  if (!found) {
    refuse(
      reviewer.binary === "codex"
        ? "the Codex CLI is not on PATH; install it with `bun add -g @openai/codex` or set KESHA_REVIEWER to a command that reads the prompt on stdin"
        : `KESHA_REVIEWER names '${reviewer.binary}', which is not found`,
    );
  }
  const target = resolveTarget();
  const fetched = run(["git", "fetch", "--quiet", "origin", target.base]);
  if (fetched.code !== 0) fail(`git fetch origin ${target.base}: ${fetched.stderr.trim()}`);

  console.error(`==> reviewing #${target.pr} at ${target.head} with ${reviewer.label}`);
  const proc = Bun.spawn(reviewer.argv, { stdin: new Blob([buildPrompt({ ...target, claim })]), stdout: "pipe", stderr: "inherit" });
  const review = await new Response(proc.stdout).text();
  const code = await proc.exited;

  mkdirSync(LOG_DIR, { recursive: true });
  const log = join(LOG_DIR, `review-${target.pr}-${target.head}.md`);
  const body = commentBody({ pr: target.pr, head: target.head, claim, reviewer: reviewer.label, review });
  writeFileSync(log, body);
  if (code !== 0) fail(`the reviewer exited ${code}; its output is in ${log}, nothing was posted`);
  if (review.trim() === "") fail("the reviewer printed nothing; nothing was posted");

  const posted = run(["gh", "pr", "comment", String(target.pr), "--body-file", log]);
  if (posted.code !== 0) fail(`gh pr comment: ${posted.stderr.trim()}; the review is in ${log}, post it by hand`);
  console.error(`==> posted; the review is also in ${log}`);
  console.log(posted.stdout.trim());
}

if (import.meta.main) await main();
