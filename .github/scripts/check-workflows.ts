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
import { readdirSync, readFileSync } from "node:fs";
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

/**
 * Fails when build-engine.yml's build job would upload an artifact it never synthesised with.
 * That workflow runs on releases only, so this is the one lane a PR can hold it to (#671).
 */
export function requirePreUploadSynthesisSmoke(path: string, document: unknown): string[] {
  if (!path.endsWith("build-engine.yml")) return [];

  const steps = (document as { jobs?: { build?: { steps?: unknown[] } } })?.jobs?.build?.steps;
  if (!Array.isArray(steps)) return [`${path}: expected a \`build\` job with steps`];

  const index = (match: (step: { run?: unknown; uses?: unknown }) => boolean) =>
    steps.findIndex((step) => typeof step === "object" && step !== null && match(step));

  const smoke = index((step) => typeof step.run === "string" && step.run.includes("smoke-synthesis.ts"));
  const upload = index((step) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact"));

  if (smoke === -1) {
    return [`${path}: the build job must run smoke-synthesis.ts before uploading the artifact (#671)`];
  }
  if (upload !== -1 && smoke > upload) {
    return [`${path}: smoke-synthesis.ts runs after the artifact is uploaded; move it before (#671)`];
  }
  return [];
}

function main(): void {
  const files = dirs.flatMap((dir) => collectYamlFiles(dir)).sort();

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
