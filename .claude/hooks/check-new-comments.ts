#!/usr/bin/env bun
// PostToolUse(Edit|Write) gate for CLAUDE.md -> Code Style: judges only *added* comment lines, so legacy blocks stay put.
import { $ } from "bun";
import { dirname, isAbsolute, resolve } from "node:path";

const C_FAMILY = /\.(ts|tsx|js|mjs|cjs|rs|swift)$/;
const HASH_FAMILY = /\.(sh|py|toml|ya?ml|nix)$/;
// Only a `/*` followed by whitespace or the line end opens a block after code: globs, strings and regexes carry one too.
const TRAILING_OPENER = /\/\*\*?(?=\s|$)/;
const BANNER = /^(#|\/\/)\s*[-=*_]{4,}/;

type Kind = "line" | "doc" | "block" | null;
type Row = { text: string; kind: Kind; span: number; exempt: boolean };

const input = (await Bun.stdin.json().catch(() => ({}))) as { tool_input?: { file_path?: string } };
const named = input.tool_input?.file_path;
if (!named) process.exit(0);
const file = isAbsolute(named) ? named : resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), named);
const cFamily = C_FAMILY.test(file);
if (!cFamily && !HASH_FAMILY.test(file)) process.exit(0);
const source = await Bun.file(file).text().catch(() => null);
if (source === null) process.exit(0);

const openerKind = (t: string): Kind => {
  if (cFamily) {
    if (t.startsWith("///") || t.startsWith("/**")) return "doc";
    if (t.startsWith("/*")) return "block";
    if (t.startsWith("//")) return "line";
    return null;
  }
  return t.startsWith("#") && !t.startsWith("#!") ? "line" : null;
};

// Comment-ness comes from the whole file, not the hunk: a line added inside an existing block has no delimiter in a -U0 diff.
const rows: Row[] = source.split("\n").map((raw) => ({ text: raw.trim(), kind: null, span: 1, exempt: false }));
let group: number[] = [];
let groupKind: Kind = null;
let inBlock = false;
const seal = () => {
  const exempt = groupKind === "doc" || group.some((i) => rows[i]!.text.includes("SAFETY:"));
  for (const i of group) {
    rows[i]!.span = group.length;
    rows[i]!.exempt = exempt;
  }
  group = [];
  groupKind = null;
  inBlock = false;
};
rows.forEach((row, i) => {
  const t = row.text;
  if (inBlock) {
    row.kind = groupKind;
    group.push(i);
    if (t.includes("*/")) seal();
    return;
  }
  const kind = openerKind(t);
  if (kind === "block" || (kind === "doc" && t.startsWith("/*"))) {
    seal();
    row.kind = kind;
    groupKind = kind;
    group = [i];
    if (t.includes("*/", 2)) seal();
    else inBlock = true;
    return;
  }
  if (kind === null) {
    seal();
    const at = cFamily ? t.search(TRAILING_OPENER) : -1;
    if (at >= 0 && !t.includes("*/", at)) {
      // `code; /* why` — the code line is a member for the span's sake but never a comment itself.
      groupKind = t.startsWith("/**", at) ? "doc" : "block";
      group = [i];
      inBlock = true;
    }
    return;
  }
  if (kind !== groupKind) seal();
  row.kind = kind;
  groupKind = kind;
  group.push(i);
});
seal();

// The hook's cwd is the session root; a worktree file must be diffed from its own checkout or git reports nothing and the gate passes silently.
const cwd = dirname(file);
const tracked = (await $`git ls-files --error-unmatch -- ${file}`.cwd(cwd).nothrow().quiet()).exitCode === 0;
// Against HEAD, so a change the agent already staged is still judged; with no HEAD (fresh repo) or no index entry, every line is new.
const diff = tracked ? await $`git diff HEAD -U0 -- ${file}`.cwd(cwd).nothrow().quiet() : null;
const added: number[] = [];
if (diff && diff.exitCode === 0) {
  for (const m of diff.text().matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let n = start; n < start + count; n++) added.push(n);
  }
} else for (let n = 1; n <= rows.length; n++) added.push(n);

const violations = new Set<string>();
for (const n of added) {
  const row = rows[n - 1];
  if (!row?.kind) continue;
  if (BANNER.test(row.text)) violations.add(`banner: ${row.text}`);
  if (row.span > 1 && !row.exempt) violations.add(`line of a ${row.span}-line comment: ${row.text}`);
}

if (violations.size === 0) process.exit(0);

console.log(
  JSON.stringify({
    decision: "block",
    reason:
      `CLAUDE.md -> Code Style violated in ${file}.\n` +
      `Comments are ONE line, carrying only what the code cannot: non-obvious why, ` +
      `a gotcha, an issue ref, a spec citation, SAFETY, or a doc contract. ` +
      `Never narrate mechanics or restate the code. More than one line is a bug, not a style ` +
      `choice — if it needs two sentences, it belongs in the commit message or the issue.\n\n` +
      [...violations].map((v) => `  - ${v}`).join("\n") +
      `\n\nRewrite each to a single line or delete it, then continue.`,
  }),
);
