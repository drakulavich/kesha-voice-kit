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
  const proc = Bun.spawnSync(["kesha", path], { stdout: "pipe", stderr: "pipe" });
  const result = proc.stdout.toString().trim();

  if (!result) {
    console.log(`  FAIL  ${file} — empty transcript`);
    failed++;
  } else {
    console.log(`  PASS  ${file} — ${result.slice(0, 60)}...`);
    passed++;
  }
}

// E2E: --verbose flag should include "Text language:" line
const verboseFile = resolve(fixturesDir, files[0]);
const verboseProc = Bun.spawnSync(["kesha", "--verbose", verboseFile], { stdout: "pipe", stderr: "pipe" });
const verboseOut = verboseProc.stdout.toString();

if (verboseOut.includes("Text language:") && verboseOut.includes("---")) {
  console.log(`  PASS  --verbose output contains language info`);
  passed++;
} else {
  console.log(`  FAIL  --verbose output missing language info`);
  failed++;
}

// E2E: --json flag should produce valid JSON with lang field
const jsonProc = Bun.spawnSync(["kesha", "--json", verboseFile], { stdout: "pipe", stderr: "pipe" });
const jsonOut = jsonProc.stdout.toString().trim();

try {
  const parsed = JSON.parse(jsonOut);
  if (Array.isArray(parsed) && parsed[0]?.lang && parsed[0]?.text && parsed[0]?.textLanguage) {
    console.log(`  PASS  --json output has lang, text, and textLanguage fields`);
    passed++;
  } else {
    console.log(`  FAIL  --json output missing expected fields`);
    failed++;
  }
} catch {
  console.log(`  FAIL  --json output is not valid JSON`);
  failed++;
}

// E2E: --lang mismatch warning should appear on stderr when language doesn't match
// Russian audio file with --lang en should trigger a warning
const mismatchProc = Bun.spawnSync(["kesha", "--lang", "en", verboseFile], { stdout: "pipe", stderr: "pipe" });
const mismatchStderr = mismatchProc.stderr.toString();
const mismatchStdout = mismatchProc.stdout.toString().trim();

if (mismatchStderr.includes("expected language") && mismatchStdout) {
  console.log(`  PASS  --lang mismatch warning appears on stderr`);
  passed++;
} else {
  console.log(`  FAIL  --lang mismatch warning missing (stderr: ${mismatchStderr.slice(0, 80)})`);
  failed++;
}

// E2E: kesha install downloads engine and models
const installProc = Bun.spawnSync(["kesha", "install"], { stdout: "pipe", stderr: "pipe" });
const installOut = installProc.stdout.toString() + installProc.stderr.toString();

if (installOut.includes("installed") || installOut.includes("already") || installOut.includes("models")) {
  console.log(`  PASS  kesha install completes successfully`);
  passed++;
} else {
  console.log(`  FAIL  kesha install unexpected output (output: ${installOut.slice(0, 120)})`);
  failed++;
}

// E2E: both "kesha" and "parakeet" commands work
for (const cmd of ["kesha", "parakeet"] as const) {
  const proc = Bun.spawnSync([cmd, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode === 0 && proc.stdout.toString().trim()) {
    console.log(`  PASS  "${cmd}" command works (${proc.stdout.toString().trim()})`);
    passed++;
  } else {
    console.log(`  FAIL  "${cmd}" command not found or returned error`);
    failed++;
  }
}

const total = files.length + 6;
console.log(`\n${passed}/${total} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
