#!/usr/bin/env bun
/**
 * CoreML-vs-CoreML benchmark: Parakeet vs WhisperKit on Apple Silicon.
 * Local only — requires macOS arm64, brew, parakeet, whisperkit-cli.
 * Usage: bun scripts/benchmark-coreml.ts
 * Output: markdown to stdout
 */

import { Glob } from "bun";
import { resolve } from "path";

const repoDir = resolve(import.meta.dir, "..");
const fixturesDir = resolve(repoDir, "fixtures/benchmark");
const CLI = "kesha";
const WHISPER_CLI = "whisperkit-cli";
// Let WhisperKit auto-select the recommended model for this device

// --- Preflight checks ---

function checkCommand(cmd: string): boolean {
  return Bun.spawnSync(["which", cmd], { stdout: "pipe" }).exitCode === 0;
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("ERROR: This benchmark requires macOS Apple Silicon");
  process.exit(1);
}

if (!checkCommand(CLI)) {
  console.error("ERROR: parakeet not found. Run: bun link && parakeet install");
  process.exit(1);
}

if (!checkCommand(WHISPER_CLI)) {
  console.error("ERROR: whisperkit-cli not found. Run: brew install whisperkit-cli");
  process.exit(1);
}

// --- System info ---

const chip = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"], { stdout: "pipe" }).stdout.toString().trim();
const profiler = Bun.spawnSync(["system_profiler", "SPHardwareDataType"], { stdout: "pipe" }).stdout.toString();
const ram = profiler.match(/Memory:\s+(.+)/)?.[1] ?? "Unknown";

// --- Collect fixtures ---

const files = [...new Glob("*.ogg").scanSync(fixturesDir)].sort().map(f => resolve(fixturesDir, f));
if (files.length === 0) {
  console.error(`ERROR: No .ogg files found in ${fixturesDir}`);
  process.exit(1);
}

// --- Warm up WhisperKit (first run downloads model) ---

console.error("Warming up WhisperKit (auto-select model)...");
const warmup = Bun.spawnSync([WHISPER_CLI, "transcribe", "--audio-path", files[0]], {
  stdout: "pipe",
  stderr: "inherit",
});
if (warmup.exitCode !== 0) {
  console.error("ERROR: WhisperKit warmup failed");
  process.exit(1);
}
console.error("WhisperKit ready.");

// --- Run WhisperKit benchmark ---

console.error(`\nRunning WhisperKit benchmark (${files.length} files)...`);

interface Result { time: number; text: string }

const whisperResults: Result[] = [];
for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const name = file.split("/").pop()!.slice(0, 30);
  process.stderr.write(`  [${i + 1}/${files.length}] ${name}...`);

  const start = performance.now();
  const proc = Bun.spawnSync([WHISPER_CLI, "transcribe", "--audio-path", file], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const elapsed = (performance.now() - start) / 1000;

  // WhisperKit outputs JSON — extract text
  let text = "";
  try {
    const output = proc.stdout.toString().trim();
    const parsed = JSON.parse(output);
    text = parsed.text ?? output;
  } catch {
    text = proc.stdout.toString().trim();
  }

  console.error(` ${elapsed.toFixed(1)}s`);
  whisperResults.push({ time: Math.round(elapsed * 10) / 10, text: text.trim() });
}

// --- Run Parakeet benchmark ---

console.error(`\nRunning Parakeet benchmark (${files.length} files)...`);

const parakeetResults: Result[] = [];
for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const name = file.split("/").pop()!.slice(0, 30);
  process.stderr.write(`  [${i + 1}/${files.length}] ${name}...`);

  const start = performance.now();
  const proc = Bun.spawnSync([CLI, file], { stdout: "pipe", stderr: "pipe" });
  const elapsed = (performance.now() - start) / 1000;

  if (proc.exitCode !== 0) {
    console.error(` FAILED`);
    console.error(proc.stderr.toString());
  } else {
    console.error(` ${elapsed.toFixed(1)}s`);
  }

  parakeetResults.push({ time: Math.round(elapsed * 10) / 10, text: proc.stdout.toString().trim() });
}

// --- Generate markdown ---

const date = new Date().toISOString().split("T")[0];

const lines: string[] = [
  `## ${chip}, ${ram} RAM (CoreML vs CoreML)`,
  "",
  `**Date:** ${date}`,
  `**Models:** WhisperKit (auto-selected) vs Parakeet TDT 0.6B v3`,
  `**Backend:** Both CoreML (Apple Neural Engine)`,
  "",
  `| # | WhisperKit | Parakeet | WhisperKit Transcript | Parakeet Transcript |`,
  "|---|---------|----------|--------------------|---------------------|",
];

let wTotal = 0;
let pTotal = 0;
for (let i = 0; i < whisperResults.length; i++) {
  const w = whisperResults[i];
  const p = parakeetResults[i];
  wTotal += w.time;
  pTotal += p.time;
  lines.push(`| ${i + 1} | ${w.time}s | ${p.time}s | ${w.text} | ${p.text} |`);
}

const speedup = pTotal > 0 ? Math.round((wTotal / pTotal) * 10) / 10 : 0;
lines.push(`| **Total** | **${Math.round(wTotal * 10) / 10}s** | **${Math.round(pTotal * 10) / 10}s** | | |`);
lines.push("");
lines.push(`**Parakeet is ~${speedup}x faster** than WhisperKit (both CoreML).`);

console.log(lines.join("\n"));
