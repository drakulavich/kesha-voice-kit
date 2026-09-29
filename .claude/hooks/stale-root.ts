#!/usr/bin/env bun
import { basename, dirname } from "node:path";

export type SessionStartNotice = {
  systemMessage: string;
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
};

export type RootState = { branch: string | null; behind: number | null; ahead: number | null };

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function rootMessage({ branch, behind, ahead }: RootState, root: string): string | null {
  if (branch !== "main") {
    const where = `The root checkout ${root} is on ${branch ?? "a detached HEAD"} rather than main`;
    if (behind !== null && behind > 0 && ahead === 0) {
      return (
        `${where}, and main is ${commits(behind)} behind origin/main, so its CLAUDE.md may be stale. ` +
        `Switch back and fast-forward: cd ${shellQuote(root)} && git switch main && git fetch origin && git merge --ff-only origin/main`
      );
    }
    return `${where}, so its CLAUDE.md may not match main. Switch it back: cd ${shellQuote(root)} && git switch main`;
  }
  if (behind === null || ahead === null) {
    return (
      `The root checkout ${root} could not be compared with origin/main, so its CLAUDE.md may be stale. ` +
      `Check it: cd ${shellQuote(root)} && git fetch origin && git merge --ff-only origin/main`
    );
  }
  if (ahead > 0 && behind > 0) {
    return (
      `The root checkout ${root} has diverged from origin/main (${commits(ahead)} ahead, ${commits(behind)} behind), so its CLAUDE.md may be stale ` +
      `and git merge --ff-only will fail. Reconcile main with origin/main by hand.`
    );
  }
  if (behind > 0) {
    return (
      `The root checkout ${root} is ${commits(behind)} behind origin/main, so its CLAUDE.md may be stale. ` +
      `Fast-forward it: cd ${shellQuote(root)} && git fetch origin && git merge --ff-only origin/main`
    );
  }
  return null;
}

export function staleRootNotice(state: RootState, root: string): SessionStartNotice | null {
  const message = rootMessage(state, root);
  if (message === null) return null;
  return { systemMessage: message, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } };
}

async function git(cwd: string, args: string[], timeout: number): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out.trim() : null;
}

async function main(): Promise<void> {
  const commonDir = await git(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"], 2000);
  if (!commonDir || basename(commonDir) !== ".git") return;
  const root = dirname(commonDir);
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], 2000);
  await git(root, ["fetch", "--quiet", "origin", "main"], 5000);
  const counts = await git(root, ["rev-list", "--left-right", "--count", "origin/main...main"], 2000);
  const [behind, ahead] = (counts ?? "").split(/\s+/).map(Number);
  const counted = Number.isFinite(behind) && Number.isFinite(ahead);
  const notice = staleRootNotice({ branch, behind: counted ? behind! : null, ahead: counted ? ahead! : null }, root);
  if (notice) console.log(JSON.stringify(notice));
}

if (import.meta.main) {
  await main().catch(() => {});
  process.exit(0);
}
