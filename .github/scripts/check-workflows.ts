#!/usr/bin/env bun
/**
 * Validate GitHub workflow and composite-action YAML plus immutable action refs.
 *
 * Replaces the ad-hoc `python3 -c "import yaml; yaml.safe_load(...)"` invocation
 * we were running before each workflow change. Same effect — surface syntax
 * errors locally before `git push` instead of finding them in CI — but uses
 * the bun toolchain so contributors don't need a python interpreter on PATH.
 *
 * Run via `bun run check:workflows`. Exits non-zero on syntax errors or mutable
 * action references; stays silent on success so it composes cleanly with other
 * pre-push checks.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, YAMLParseError } from "yaml";

const dirs = [".github/workflows", ".github/actions"];

function collectYamlFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && /\.ya?ml$/.test(entry))
    .map((entry) => join(dir, entry));
}

function requirePinnedActions(path: string, contents: string): string[] {
  const errors: string[] = [];
  const actionPattern = /^\s*uses:\s+([^\s#]+)(?:\s+#.*)?$/gm;

  for (const match of contents.matchAll(actionPattern)) {
    const reference = match[1];
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/i.test(reference)) {
      errors.push(`${path}: external action must be pinned to a full commit SHA: ${reference}`);
    }
  }

  return errors;
}

type Step = { run?: unknown; uses?: unknown; if?: unknown; with?: { filters?: unknown } };

function jobSteps(document: unknown, job: string): Step[] | undefined {
  const steps = (document as { jobs?: Record<string, { steps?: unknown[] }> })?.jobs?.[job]?.steps;
  return Array.isArray(steps) ? (steps as Step[]) : undefined;
}

const condition = (step: Step) => String(step.if ?? "");

/** Indices of the steps whose `run` matches, skipping any switched off with `if: false`. */
function runsMatching(steps: Step[], pattern: RegExp): number[] {
  return steps.flatMap((step, at) =>
    typeof step?.run === "string" && pattern.test(step.run) && condition(step).trim() !== "false" ? [at] : [],
  );
}

/**
 * Fails when build-engine.yml's build job would upload an artifact it never synthesised with.
 * That workflow runs on releases only, so this is the one lane a PR can hold it to (#671).
 */
export function requirePreUploadSynthesisSmoke(path: string, document: unknown): string[] {
  if (!path.endsWith("build-engine.yml")) return [];

  const steps = jobSteps(document, "build");
  if (!steps) return [`${path}: expected a \`build\` job with steps`];

  // Anchored at line start so a commented-out or echoed mention doesn't satisfy the guard.
  const smoke = runsMatching(steps, /^\s*bun\s+\S*smoke-synthesis\.ts\b/m)[0];
  const upload = steps.findIndex((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/upload-artifact"));

  if (smoke === undefined) {
    return [`${path}: the build job must run smoke-synthesis.ts before uploading the artifact (#671)`];
  }
  if (upload === -1) {
    return [`${path}: the build job must upload the engine artifact after smoke-synthesis.ts (#671)`];
  }
  if (smoke > upload) {
    return [`${path}: smoke-synthesis.ts runs after the artifact is uploaded; move it before (#671)`];
  }
  return [];
}

/**
 * Fails when the release job packages Linux artifacts. The `.deb`/`.rpm` carry
 * `package.json#version`, which `main` holds ahead of npm since #691, so a stable engine tag can
 * never name them after a published CLI — the gate that checked this made engine releases
 * unreleasable instead (#728).
 */
export function forbidLinuxPackaging(path: string, document: unknown): string[] {
  if (!path.endsWith("build-engine.yml")) return [];

  const steps = jobSteps(document, "release");
  if (!steps) return [`${path}: expected a \`release\` job with steps`];

  // Anchored so a comment mentioning the script cannot trip it.
  return runsMatching(steps, /^[^#\n]*\blinux-packages\b/m).map(
    (at) =>
      `${path}: step ${at + 1} packages Linux artifacts into an engine release; they name an unpublished CLI version (#728)`,
  );
}

/**
 * Fails when a script covered by a unit test sits outside ci.yml's `code` filter.
 * `check:versions` and the unit tests run inside `unit-tests`, which that filter gates,
 * so an uncovered script means edits to a gate skip the tests that prove it works.
 */
export function requireTestedScriptsInCodeFilter(
  path: string,
  document: unknown,
  testedScripts: string[],
): string[] {
  if (!path.endsWith("ci.yml")) return [];

  const raw = jobSteps(document, "changes")?.find((step) => typeof step?.with?.filters === "string")?.with?.filters;
  if (typeof raw !== "string") return [`${path}: expected a \`changes\` job with inline paths-filter filters`];

  const code = (parse(raw) as Record<string, string[]>)?.code;
  if (!Array.isArray(code)) return [`${path}: paths-filter is missing a \`code\` list`];

  const covers = (file: string) =>
    code.some((pattern) => (pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : pattern === file));

  return testedScripts
    .filter((file) => !covers(file))
    .map((file) => `${path}: ${file} has a unit test but no matching path in the \`code\` filter, so edits to it skip that test`);
}

function collectTestedScripts(): string[] {
  const tests = readdirSync("tests/unit", { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".test.ts"))
    .map((entry) => readFileSync(join("tests/unit", entry), "utf8"));

  // A TS import drops the extension, a spawned script keeps it — so try both and keep what exists on disk.
  const found = new Set<string>();
  for (const contents of tests) {
    for (const match of contents.matchAll(/\.github\/scripts\/([\w.-]+)/g)) {
      for (const candidate of [match[1], `${match[1]}.ts`]) {
        const file = join(".github/scripts", candidate);
        if (existsSync(file)) found.add(file);
      }
    }
  }
  return [...found].sort();
}

function main(): void {
  const files = dirs.flatMap((dir) => collectYamlFiles(dir)).sort();
  const testedScripts = collectTestedScripts();

  if (files.length === 0) {
    console.error(`no workflow or action files found in ${dirs.join(", ")}`);
    process.exit(1);
  }

  let failed = 0;
  for (const path of files) {
    try {
      const contents = readFileSync(path, "utf8");
      const document = parse(contents);
      const errors = [
        ...requirePinnedActions(path, contents),
        ...requirePreUploadSynthesisSmoke(path, document),
        ...forbidLinuxPackaging(path, document),
        ...requireTestedScriptsInCodeFilter(path, document, testedScripts),
      ];
      if (errors.length > 0) {
        failed += errors.length;
        for (const error of errors) console.error(error);
      }
    } catch (err) {
      failed += 1;
      if (err instanceof YAMLParseError) {
        // Rendered line:col so editors can jump to the offending position.
        console.error(`${path}:${err.linePos?.[0]?.line ?? "?"}:${err.linePos?.[0]?.col ?? "?"}: ${err.message}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${path}: ${msg}`);
      }
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} workflow or action check(s) failed.`);
    process.exit(1);
  }
}

if (import.meta.main) main();
