#!/usr/bin/env bun
/**
 * Fails when a documented `just <recipe>` names a recipe the justfile does not define, when a
 * recipe runs a pipeline whose exit status nothing makes honest, or when a
 * recipe carries no doc comment — `just --list` renders that comment, so an undocumented recipe is
 * invisible. This is what makes #797's Makefile sweep verifiable rather than grep-and-hope, and it
 * is a gate `make` cannot support at all, having no introspection.
 *
 * EXTRACTION is deliberately conservative, because "just" is also an English adverb and the swept
 * files are mostly prose. A reference counts only inside a *command context* —
 *   - markdown: a fenced code block, or an inline `code span`
 *   - YAML: a `run:` scalar, inline or block
 * — and only when `just` sits at a command boundary (line start, or after `;` `&&` `||` `|` `(`
 * `$(`), followed by any number of `NAME=value` assignments, and the next token is kebab-case.
 * A flag (`just --list`) or any other token shape is skipped rather than guessed at.
 *
 * The pipefail rule scans for a `|` the shell would read as a pipeline, tracking quotes, escapes and
 * trailing comments. Its one known false positive is an unquoted alternation inside `[[ x =~ a|b ]]`,
 * which is fragile shell anyway — quote the pattern or lift it into a variable.
 *
 * Known false negatives, all of them deliberate: a reference in prose with no backticks; a trailing
 * comma inside the code span (`just test,`); `just $RECIPE`; `.claude/settings.json`, whose
 * `Bash(just:*)` allowlist entries are permission patterns, not invocations. Known false positive:
 * an English sentence that both sits in a code span and reads `just <lowercase-word>` — none exist
 * in the swept set today, and the fix would be to drop backticks that are wrong anyway.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Recipe = {
  doc?: string | null;
  private?: boolean;
  shebang?: boolean;
  parameters?: { name?: string }[];
  body?: unknown;
};
export type JustDump = { recipes?: Record<string, Recipe>; aliases?: Record<string, unknown> };

const SWEPT_ROOT_FILES = ["README.md", "CONTRIBUTING.md", "CLAUDE.md"];
const SWEPT_DIRS = ["docs/", ".claude/", ".github/workflows/"];
// Historical records of what was true when written, which #797 leaves alone.
const EXCLUDED_DIRS = ["docs/superpowers/", "docs/plans/"];

export function isSwept(path: string): boolean {
  if (!/\.(md|ya?ml)$/.test(path)) return false;
  if (EXCLUDED_DIRS.some((dir) => path.startsWith(dir))) return false;
  return SWEPT_ROOT_FILES.includes(path) || SWEPT_DIRS.some((dir) => path.startsWith(dir));
}

export function sweptFiles(root: string): string[] {
  const nested = SWEPT_DIRS.flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true })
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => `${dir}${entry.split("\\").join("/")}`),
  );
  return [...SWEPT_ROOT_FILES, ...nested].filter(isSwept).sort();
}

export type CommandLine = { line: number; text: string };

/** The lines of `contents` a shell would run, by the rules in this file's header. */
export function commandLines(path: string, contents: string): CommandLine[] {
  const lines = contents.replace(/\r\n/g, "\n").split("\n");
  if (path.endsWith(".md")) return markdownCommands(lines);
  if (/\.ya?ml$/.test(path)) return yamlRunCommands(lines);
  return [];
}

function markdownCommands(lines: string[]): CommandLine[] {
  const found: CommandLine[] = [];
  let fenced = false;
  for (const [at, raw] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      found.push({ line: at + 1, text: raw });
      continue;
    }
    for (const span of raw.matchAll(/`([^`]+)`/g)) found.push({ line: at + 1, text: span[1] ?? "" });
  }
  return found;
}

function yamlRunCommands(lines: string[]): CommandLine[] {
  const found: CommandLine[] = [];
  let blockIndent: number | null = null;
  for (const [at, raw] of lines.entries()) {
    const indent = raw.search(/\S/);
    if (blockIndent !== null) {
      // A blank line inside a block scalar carries no indentation of its own.
      if (indent === -1) continue;
      if (indent > blockIndent) {
        found.push({ line: at + 1, text: raw });
        continue;
      }
      blockIndent = null;
    }
    const step = raw.match(/^\s*(?:-\s+)?run:\s*(.*)$/);
    if (!step) continue;
    const value = (step[1] ?? "").trim();
    if (value === "" || /^[|>][-+\d]*$/.test(value)) blockIndent = raw.indexOf("run:");
    else found.push({ line: at + 1, text: value });
  }
  return found;
}

const INVOCATION = /(?:^|[;&|(]|\$\()\s*just\s+((?:[A-Za-z_][\w-]*=\S*\s+)*)(\S+)/g;
const RECIPE_NAME = /^[a-z][a-z0-9-]*$/;

export type Reference = { line: number; recipe: string; text: string };

export function referencedRecipes(path: string, contents: string): Reference[] {
  const found: Reference[] = [];
  for (const { line, text } of commandLines(path, contents)) {
    for (const match of text.matchAll(INVOCATION)) {
      const recipe = match[2];
      if (!recipe || !RECIPE_NAME.test(recipe)) continue;
      found.push({ line, recipe, text: text.trim() });
    }
  }
  return found;
}

/** Aliases are invocable names too, so `just release` must resolve through `release-preflight`. */
export function knownRecipeNames(dump: JustDump): Set<string> {
  return new Set([...Object.keys(dump.recipes ?? {}), ...Object.keys(dump.aliases ?? {})]);
}

export function unknownReferences(path: string, contents: string, known: Set<string>): string[] {
  return referencedRecipes(path, contents)
    .filter(({ recipe }) => !known.has(recipe))
    .map(
      ({ line, recipe, text }) =>
        `${path}:${line}: \`just ${recipe}\` names a recipe the justfile does not define (in \`${text}\`)`,
    );
}

function interpolatedNames(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  if (body[0] === "variable" && typeof body[1] === "string") return [body[1]];
  return body.flatMap(interpolatedNames);
}

/**
 * `{{ slug }}` is substituted into the recipe *text*, which the shell then parses — so quoting it
 * as `"{{ slug }}"` survives spaces and nothing else, and a caller passing `x"; rm -rf ~; #` gets
 * their payload run. This is #291's GHA `run:` class one layer down. The fix is `[positional-arguments]`
 * plus `"$1"`, where the shell receives the value as data it never re-parses.
 */
export function interpolatedParameters(dump: JustDump): string[] {
  return Object.entries(dump.recipes ?? {}).flatMap(([name, recipe]) => {
    const parameters = new Set((recipe.parameters ?? []).map((p) => p.name));
    const offenders = [...new Set(interpolatedNames(recipe.body))]
      .filter((used) => parameters.has(used))
      .sort();
    if (offenders.length === 0) return [];
    return [
      `justfile: recipe \`${name}\` interpolates ${offenders.map((o) => `{{ ${o} }}`).join(", ")} ` +
        `into its body, so a caller's shell metacharacters are parsed as code — add ` +
        `[positional-arguments] and read the value as "$1" instead (#907)`,
    ];
  });
}

function lineText(fragment: unknown): string {
  if (typeof fragment === "string") return fragment;
  if (!Array.isArray(fragment)) return "";
  if (fragment[0] === "variable" && typeof fragment[1] === "string") return `{{${fragment[1]}}}`;
  return fragment.map(lineText).join("");
}

/** True when the shell would read a `|` in `text` as a pipeline rather than as data. */
export function runsAPipeline(text: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      at++;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (at === 0 || /\s/.test(text[at - 1] ?? ""))) return false;
    if (char !== "|") continue;
    if (text[at + 1] === "|") {
      at++;
      continue;
    }
    if (text[at - 1] !== ">") return true;
  }
  return false;
}

const SETS_PIPEFAIL = /^\s*set\s+(?:-\S+\s+)*pipefail\b/;

/**
 * A pipeline's exit status is its *last* stage's, so `just worktree-rm x | tail -3 && echo removed`
 * reports success for a `just` that failed — three times in one session, once about a worktree that
 * was still there (#1083). `set -o pipefail` is the fix, and `sh -cu` — what `just` runs a
 * non-shebang recipe under — has no portable spelling of it.
 */
export function unguardedPipelines(dump: JustDump): string[] {
  return Object.entries(dump.recipes ?? {}).flatMap(([name, recipe]) => {
    let guarded = false;
    for (const line of (Array.isArray(recipe.body) ? recipe.body : []).map(lineText)) {
      if (SETS_PIPEFAIL.test(line)) guarded = true;
      if (guarded || !runsAPipeline(line)) continue;
      const fix = recipe.shebang
        ? "add `set -euo pipefail` above it"
        : "give the recipe a `#!/usr/bin/env bash` line and `set -euo pipefail`, since `sh -cu` " +
          "(what `just` runs a non-shebang recipe under) has no portable pipefail";
      return [
        `justfile: recipe \`${name}\` runs a pipeline without pipefail, so it reports only the ` +
          `last stage's exit status (in \`${line.trim()}\`) — ${fix} (#1083)`,
      ];
    }
    return [];
  });
}

export function undocumentedRecipes(dump: JustDump): string[] {
  return Object.entries(dump.recipes ?? {})
    .filter(([, recipe]) => !recipe.private && !recipe.doc)
    .map(
      ([name]) =>
        `justfile: recipe \`${name}\` has no doc comment, so \`just --list\` shows it with no ` +
        `explanation — add a \`# …\` line directly above it (#797)`,
    );
}

const MISSING_JUST =
  "`just` is not on PATH, and this gate parses `just --dump --dump-format json`.\n" +
  "  Fix: cargo install --locked just (or brew install just); in CI, add a taiki-e/install-action\n" +
  "  step with `tool: just@<version>` to the job before this check.";

function loadDump(): JustDump {
  let result;
  try {
    result = Bun.spawnSync(["just", "--dump", "--dump-format", "json"]);
  } catch {
    // Bun throws rather than returning a failed result when the binary is absent.
    console.error(MISSING_JUST);
    process.exit(1);
  }
  if (!result.success) {
    console.error(`justfile: \`just --dump\` failed.\n${result.stderr.toString().trim()}`);
    process.exit(1);
  }
  return JSON.parse(result.stdout.toString());
}

function main(): void {
  const dump = loadDump();
  const known = knownRecipeNames(dump);
  const root = process.cwd();

  const errors = [
    ...undocumentedRecipes(dump),
    ...interpolatedParameters(dump),
    ...unguardedPipelines(dump),
    ...sweptFiles(root).flatMap((path) =>
      unknownReferences(path, readFileSync(join(root, path), "utf8"), known),
    ),
  ];
  for (const error of errors) console.error(error);

  if (errors.length > 0) {
    console.error(`\n${errors.length} recipe check(s) failed. Defined recipes: ${[...known].sort().join(", ")}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
