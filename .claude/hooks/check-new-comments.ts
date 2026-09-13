#!/usr/bin/env bun
// PostToolUse(Edit|Write) gate for CLAUDE.md -> Code Style: judges only *added* comment lines, so legacy blocks stay put.
import { $ } from "bun";
import { dirname, isAbsolute, resolve } from "node:path";

const CODE = /\.(ts|tsx|js|mjs|cjs|rs|sh|py|swift|toml|ya?ml|nix)$/;
// `#[derive]`/`#[test]` are Rust attributes and `#!` a shebang, not comments.
const COMMENT = /^\+\s*(#(?![\[!])|\/\/|\/\*|\*)/;
const BANNER = /^\+\s*(#|\/\/)\s*[-=*_]{4,}/;
const exempt = (run: string[]) => run.some((l) => l.includes("SAFETY:")) || /^(\/\/\/|\/\*\*)/.test(run[0]!);

const input = (await Bun.stdin.json().catch(() => ({}))) as { tool_input?: { file_path?: string } };
const named = input.tool_input?.file_path;
if (!named) process.exit(0);
const file = isAbsolute(named) ? named : resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), named);
if (!CODE.test(file)) process.exit(0);

// The hook's cwd is the session root; a worktree file must be diffed from its own checkout or git reports nothing and the gate passes silently.
const cwd = dirname(file);
const tracked = (await $`git ls-files --error-unmatch -- ${file}`.cwd(cwd).nothrow().quiet()).exitCode === 0;
// A file Write just created has no diff, and every line of it is an added line.
const diff = tracked
  ? await $`git diff -U0 -- ${file}`.cwd(cwd).nothrow().quiet().text()
  : (await Bun.file(file).text()).split("\n").map((l) => `+${l}`).join("\n");

const violations: string[] = [];
let run: string[] = [];
let inBlock = false;

const flush = () => {
  if (run.length > 1 && !exempt(run)) violations.push(`${run.length}-line block:\n      ${run.join("\n      ")}`);
  run = [];
};

for (const line of diff.split("\n")) {
  const added = line.startsWith("+") && !line.startsWith("+++");
  if (added && (inBlock || COMMENT.test(line))) {
    if (BANNER.test(line)) violations.push(`banner: ${line.slice(1).trim()}`);
    const body = line.slice(1).trim();
    run.push(body);
    inBlock = inBlock ? !body.includes("*/") : body.includes("/*") && !body.includes("*/");
  } else {
    inBlock = false;
    flush();
  }
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
