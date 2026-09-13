#!/usr/bin/env bun
// PostToolUse(Edit|Write) gate for CLAUDE.md -> Code Style: judges only *added* comment lines, so legacy blocks stay put.
import { $ } from "bun";
import { dirname, isAbsolute, resolve } from "node:path";

const CODE = /\.(ts|tsx|js|mjs|cjs|rs|sh|py|swift|toml|ya?ml|nix)$/;
// `#[derive]`/`#[test]` are Rust attributes and `#!` a shebang, not comments.
const OPENER = /^(#(?![\[!])|\/\/|\/\*)/;
const BANNER = /^(#|\/\/)\s*[-=*_]{4,}/;

const input = (await Bun.stdin.json().catch(() => ({}))) as { tool_input?: { file_path?: string } };
const named = input.tool_input?.file_path;
if (!named) process.exit(0);
const file = isAbsolute(named) ? named : resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), named);
if (!CODE.test(file)) process.exit(0);

// Comment-ness comes from the whole file, not the hunk: a line added inside an existing /* */ block has no delimiter in a -U0 diff.
const lines = (await Bun.file(file).text()).split("\n").map((l) => l.trim());
type Kind = "line" | "doc" | "block" | null;
const kind: Kind[] = [];
const span: number[] = [];
let open: Kind = null;
let members: number[] = [];
const close = () => {
  for (const i of members) span[i] = members.length;
  members = [];
  open = null;
};
lines.forEach((t, i) => {
  if (open) {
    kind.push(open);
    members.push(i);
    if (t.includes("*/")) close();
  } else if (OPENER.test(t)) {
    const block = t.startsWith("/*") && !t.includes("*/") ? (t.startsWith("/**") ? "doc" : "block") : null;
    kind.push(block ?? (t.startsWith("///") || t.startsWith("/**") ? "doc" : "line"));
    span.push(1);
    if (block) {
      open = block;
      members = [i];
    }
  } else {
    kind.push(null);
    span.push(1);
    // `code; /* why` opens a block whose continuation lines are comments even though this line is not.
    const at = t.indexOf("/*");
    if (at >= 0 && !t.includes("*/", at)) {
      open = t.startsWith("/**", at) ? "doc" : "block";
      members = [i];
    }
  }
});
close();

// The hook's cwd is the session root; a worktree file must be diffed from its own checkout or git reports nothing and the gate passes silently.
const cwd = dirname(file);
const tracked = (await $`git ls-files --error-unmatch -- ${file}`.cwd(cwd).nothrow().quiet()).exitCode === 0;
const added: number[] = [];
if (tracked) {
  // Against HEAD, so a change the agent already staged is still judged.
  const diff = await $`git diff HEAD -U0 -- ${file}`.cwd(cwd).nothrow().quiet().text();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let n = start; n < start + count; n++) added.push(n);
  }
} else for (let n = 1; n <= lines.length; n++) added.push(n);

const violations: string[] = [];
let run: string[] = [];
let exempt = false;
const flush = () => {
  if (run.length > 1 && !exempt) violations.push(`${run.length}-line block:\n      ${run.join("\n      ")}`);
  run = [];
  exempt = false;
};
let previous = -1;
let runKind: Kind = null;
for (const n of added) {
  const k = kind[n - 1];
  const t = lines[n - 1]!;
  // A doc line and the // lines after it are separate runs, or the doc exemption would cover them.
  if (!k || n !== previous + 1 || k !== runKind) flush();
  runKind = k;
  if (k) {
    if (BANNER.test(t)) violations.push(`banner: ${t}`);
    // Growing a legacy /* */ block by one line is still a multi-line comment the agent wrote into.
    if (k === "block" && span[n - 1]! > 1) violations.push(`line added inside a ${span[n - 1]}-line block: ${t}`);
    run.push(t);
    if (k === "doc" || t.includes("SAFETY:")) exempt = true;
  }
  previous = n;
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
