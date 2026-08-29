const tree = Bun.argv[2];
if (!tree || tree.startsWith("origin/")) {
  console.error("usage: bun check-citations.ts <worktree-abs> [base] [head]");
  process.exit(2);
}
const base = Bun.argv[3] ?? "origin/main";
const head = Bun.argv[4] ?? "HEAD";
// Failures exit 2 loudly: a swallowed git error once returned "0 citations" green from the wrong cwd.
const sh = (a: string[]) => {
  const r = Bun.spawnSync(a, { cwd: tree, stdout: "pipe", stderr: "pipe" });
  if (!r.success) {
    console.error(`FAILED (exit ${r.exitCode}): ${a.join(" ")}\n${r.stderr.toString().trim()}`);
    process.exit(2);
  }
  return r.stdout.toString();
};
const tracked = sh(["git", "ls-tree", "-r", "--name-only", head]).split("\n").filter(Boolean);
const byBase = new Map<string, string[]>();
for (const p of tracked) {
  const b = p.split("/").pop()!;
  byBase.set(b, [...(byBase.get(b) ?? []), p]);
}
const diff = sh(["git", "diff", `${base}...${head}`, "--", ".", ":(exclude).claude/skills/ticket-team/*"]);
const cites = new Set<string>();
for (const l of diff.split("\n")) {
  if (!l.startsWith("+") || l.startsWith("+++")) continue;
  for (const m of l.matchAll(/([\w./-]+\.(?:ya?ml|ts|rs|md|json|nix)):(\d+)/g)) cites.add(`${m[1]}:${m[2]}`);
}
let bad = 0;
for (const c of [...cites].sort()) {
  const i = c.lastIndexOf(":");
  const ref = c.slice(0, i), n = Number(c.slice(i + 1));
  const paths = tracked.includes(ref) ? [ref] : (byBase.get(ref.split("/").pop()!) ?? []).filter(p => p.endsWith(ref));
  if (paths.length !== 1) { console.log(`UNRESOLVED  ${c}  (${paths.length} candidates)`); bad++; continue; }
  const line = sh(["git", "show", `${head}:${paths[0]}`]).split("\n")[n - 1];
  const stale = line === undefined || line.trim() === "";
  console.log(`${stale ? "STALE      " : "ok         "} ${c} → ${stale ? "blank / out of range" : line.trim().slice(0, 58)}`);
  if (stale) bad++;
}
console.log(`\n${cites.size} added citation(s), ${bad} unusable`);
process.exit(bad ? 1 : 0);
