#!/usr/bin/env bun
import { basename, dirname } from "node:path";

export type SessionStartNotice = {
  systemMessage: string;
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
};

export function staleRootNotice(behind: number, root: string): SessionStartNotice | null {
  if (!(behind > 0)) return null;
  const message =
    `The root checkout ${root} is ${behind} commit${behind === 1 ? "" : "s"} behind origin/main, so its CLAUDE.md may be stale. ` +
    `Fast-forward it: cd ${root} && git fetch origin && git merge --ff-only origin/main`;
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
  await git(root, ["fetch", "--quiet", "origin", "main"], 5000);
  const behind = await git(root, ["rev-list", "--count", "HEAD..origin/main"], 2000);
  const notice = staleRootNotice(Number(behind), root);
  if (notice) console.log(JSON.stringify(notice));
}

if (import.meta.main) {
  await main().catch(() => {});
  process.exit(0);
}
