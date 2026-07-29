#!/usr/bin/env bun
/**
 * Validate GitHub workflow and composite-action YAML plus local safety rules.
 *
 * Replaces the ad-hoc `python3 -c "import yaml; yaml.safe_load(...)"` invocation
 * we were running before each workflow change. Same effect — surface syntax
 * errors locally before `git push` instead of finding them in CI — but uses
 * the bun toolchain so contributors don't need a python interpreter on PATH.
 *
 * Run via `bun run check:workflows`. Exits non-zero on syntax errors, mutable
 * action references, or unsafe shell interpolation; stays silent on success so
 * it composes cleanly with other pre-push checks.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, YAMLParseError } from "yaml";

const dirs = [".github/workflows", ".github/actions"];
const files = dirs.flatMap((dir) => collectYamlFiles(dir)).sort();

if (files.length === 0) {
  console.error(`no workflow or action files found in ${dirs.join(", ")}`);
  process.exit(1);
}

function collectYamlFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((entry) => typeof entry === "string" && /\.ya?ml$/.test(entry))
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

function requireSafeRunInterpolation(path: string, document: unknown): string[] {
  const errors: string[] = [];
  const untrustedExpression = /\$\{\{\s*(?:inputs\.|github\.event\.|steps\.[^.]+\.outputs\.)/;

  function visit(node: unknown) {
    if (Array.isArray(node)) {
      for (const value of node) visit(value);
      return;
    }
    if (!node || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    if (typeof record.run === "string" && untrustedExpression.test(record.run)) {
      errors.push(`${path}: pass untrusted GitHub expressions to run via env, not direct interpolation`);
    }
    for (const value of Object.values(record)) visit(value);
  }

  visit(document);
  return errors;
}

let failed = 0;
for (const path of files) {
  try {
    const contents = readFileSync(path, "utf8");
    const document = parse(contents);
    const errors = [
      ...requirePinnedActions(path, contents),
      ...requireSafeRunInterpolation(path, document),
    ];
    if (errors.length > 0) {
      failed += errors.length;
      for (const error of errors) console.error(error);
    }
  } catch (err) {
    failed += 1;
    if (err instanceof YAMLParseError) {
      // YAMLParseError gives line/col + a code; render it the way most
      // tools do so editors can jump to the offending position.
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
