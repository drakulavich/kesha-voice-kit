#!/usr/bin/env bun
// PostToolUse(Edit|Write) gate for CLAUDE.md -> Code Style.
// Judges only *added* comment lines, so the repo's legacy blocks stay put.
import { $ } from "bun";
import { dirname } from "node:path";

const EXEMPT = /(SAFETY:|^\/\/\/|^\/\*\*|^\*)/;
// `#[derive]`/`#[test]` are Rust attributes, not comments — matching them flagged every new test.
const COMMENT = /^\+\s*(#(?!\[)|\/\/)/;
const BANNER = /^\+\s*(#|\/\/)\s*[-=*_]{4,}/;

const input = (await Bun.stdin.json().catch(() => ({}))) as {
  tool_input?: { file_path?: string };
};
const file = input.tool_input?.file_path;
if (!file) process.exit(0);

// The hook's cwd is the session root; a worktree file must be diffed from its own checkout or git reports nothing and the gate passes silently.
const diff = await $`git diff -U0 -- ${file}`.cwd(dirname(file)).nothrow().quiet().text();
const violations: string[] = [];
let run: string[] = [];

const flush = () => {
  if (run.length > 1 && !run.some((l) => EXEMPT.test(l))) {
    violations.push(`${run.length}-line block:\n      ${run.join("\n      ")}`);
  }
  run = [];
};

for (const line of diff.split("\n")) {
  if (COMMENT.test(line)) {
    if (BANNER.test(line)) violations.push(`banner: ${line.replace(/^\+/, "").trim()}`);
    run.push(line.replace(/^\+/, "").trim());
  } else flush();
}
flush();

if (violations.length === 0) process.exit(0);

console.log(
  JSON.stringify({
    decision: "block",
    reason:
      `CLAUDE.md -> Code Style violated in ${file}.\n` +
      `Comments are ONE line, carrying only what the code cannot: non-obvious why, ` +
      `a gotcha, an issue ref, a spec citation, SAFETY, or a doc contract. ` +
      `Never narrate mechanics or restate the code. More than one line is a bug, not a style ` +
      `choice — if it needs two sentences, it belongs in the commit message or the issue.\n\n` +
      violations.map((v) => `  - ${v}`).join("\n") +
      `\n\nRewrite each to a single line or delete it, then continue.`,
  }),
);
