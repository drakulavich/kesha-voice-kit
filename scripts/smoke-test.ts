#!/usr/bin/env bun
/**
 * Smoke test: run parakeet against benchmark fixtures and verify output.
 * Usage: bun scripts/smoke-test.ts
 * Exit code 0 if all files produce non-empty transcripts, 1 otherwise.
 */

import { Glob } from "bun";
import { resolve } from "path";

const fixturesDir = resolve(import.meta.dir, "../fixtures/benchmark");
const glob = new Glob("*.ogg");
const files = [...glob.scanSync(fixturesDir)].sort();

if (files.length === 0) {
  console.error(`ERROR: No .ogg files found in ${fixturesDir}`);
  process.exit(1);
}

console.log("Running smoke tests against benchmark fixtures...\n");

let passed = 0;
let failed = 0;

for (const file of files) {
  const path = resolve(fixturesDir, file);
  const proc = Bun.spawnSync(["parakeet", path], { stdout: "pipe", stderr: "pipe" });
  const result = proc.stdout.toString().trim();

  if (!result) {
    console.log(`  FAIL  ${file} — empty transcript`);
    failed++;
  } else {
    console.log(`  PASS  ${file} — ${result.slice(0, 60)}...`);
    passed++;
  }
}

console.log(`\n${passed}/${files.length} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
