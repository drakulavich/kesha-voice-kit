#!/usr/bin/env bun
/**
 * Benchmark: faster-whisper vs parakeet-cli
 * Cross-platform: CoreML on macOS arm64, ONNX elsewhere.
 * Outputs markdown to stdout, writes benchmark-summary.json.
 */

import { Glob } from "bun";
import { resolve } from "path";

const repoDir = resolve(import.meta.dir, "..");
const fixturesDir = resolve(repoDir, "fixtures/benchmark");
const CLI = "parakeet";

// --- System detection ---

function getSystemInfo(): { os: string; arch: string; chip: string; ram: string; backend: string } {
  const os = process.platform === "darwin" ? "Darwin" : process.platform === "linux" ? "Linux" : "Windows";
  const arch = process.arch;

  let chip = "Unknown";
  let ram = "Unknown";
  let backend = "ONNX";

  if (os === "Darwin") {
    chip = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"], { stdout: "pipe" }).stdout.toString().trim() || "Unknown";
    const profiler = Bun.spawnSync(["system_profiler", "SPHardwareDataType"], { stdout: "pipe" }).stdout.toString();
    const ramMatch = profiler.match(/Memory:\s+(.+)/);
    ram = ramMatch?.[1] ?? "Unknown";
    backend = arch === "arm64" ? "CoreML" : "ONNX";
  } else if (os === "Linux") {
    const lscpu = Bun.spawnSync(["lscpu"], { stdout: "pipe" }).stdout.toString();
    const chipMatch = lscpu.match(/Model name:\s+(.*)/);
    chip = chipMatch?.[1]?.trim() ?? "Unknown";
    const free = Bun.spawnSync(["free", "-h"], { stdout: "pipe" }).stdout.toString();
    const ramMatch = free.match(/Mem:\s+(\S+)/);
    ram = ramMatch?.[1] ?? "Unknown";
  }

  return { os, arch, chip, ram, backend };
}

// --- Collect fixtures ---

const files = [...new Glob("*.ogg").scanSync(fixturesDir)].sort().map(f => resolve(fixturesDir, f));
if (files.length === 0) {
  console.error(`ERROR: No .ogg files found in ${fixturesDir}`);
  process.exit(1);
}

const sys = getSystemInfo();

// --- Install backend ---

const version = Bun.spawnSync([CLI, "--version"], { stdout: "pipe" }).stdout.toString().trim() || "unknown";

// Verify backend is installed
const { isModelInstalled } = await import("../src/models");
if (!isModelInstalled()) {
  console.error("ERROR: No backend installed. Run: parakeet install");
  process.exit(1);
}

// --- Run faster-whisper via Python ---

console.error(`Running faster-whisper benchmark (${files.length} files)...`);

const whisperPython = `
import sys, time, json, tempfile, subprocess, os

venv = tempfile.mkdtemp()
subprocess.run([sys.executable, "-m", "venv", venv], check=True, capture_output=True)
pip = os.path.join(venv, "bin", "pip")
subprocess.run([pip, "install", "-q", "faster-whisper"], check=True, capture_output=True)

# Add venv site-packages to sys.path (Unix layout only)
site_packages = os.path.join(venv, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages")
sys.path.insert(0, site_packages)

from faster_whisper import WhisperModel
model = WhisperModel("medium", device="cpu", compute_type="int8")

results = []
total = len(sys.argv[1:])
for i, f in enumerate(sys.argv[1:], 1):
    name = os.path.basename(f)[:30]
    print(f"  [{i}/{total}] {name}...", end="", flush=True, file=sys.stderr)
    start = time.time()
    segments, info = model.transcribe(f, language="ru")
    text = " ".join(s.text.strip() for s in segments)
    elapsed = time.time() - start
    print(f" {elapsed:.1f}s", file=sys.stderr)
    results.append({"time": round(elapsed, 1), "text": text})

import shutil
shutil.rmtree(venv, ignore_errors=True)
print(json.dumps(results, ensure_ascii=False))
`;

const whisperProc = Bun.spawnSync(["python3", "-c", whisperPython, ...files], {
  stdout: "pipe",
  stderr: "inherit",
});
if (whisperProc.exitCode !== 0) {
  console.error("faster-whisper benchmark failed");
  process.exit(1);
}
const whisperResults: Array<{ time: number; text: string }> = JSON.parse(whisperProc.stdout.toString());

// --- Run parakeet ---

console.error(`Running parakeet benchmark (${files.length} files)...`);

// Verify parakeet works before benchmarking
console.error("Verifying parakeet transcription...");
const testProc = Bun.spawnSync([CLI, files[0]], { stdout: "pipe", stderr: "pipe" });
if (testProc.exitCode !== 0) {
  console.error("Parakeet verification failed:");
  console.error(testProc.stderr.toString());
  process.exit(1);
}
console.error(`Verification OK: "${testProc.stdout.toString().trim().slice(0, 50)}..."`);

const parakeetResults: Array<{ time: number; text: string }> = [];
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
  "",
  `**Date:** ${date}`,
  `**Version:** v${version}`,
  `**Runner:** ${sys.os} ${sys.arch} (${sys.chip}, ${sys.ram} RAM)`,
  `**Backend:** ${sys.backend}`,
  "",
  `| # | faster-whisper | Parakeet (${sys.backend}) | faster-whisper Transcript | Parakeet Transcript |`,
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
lines.push(`**Parakeet is ~${speedup}x faster.**`);

console.log(lines.join("\n"));

// --- Write summary for regression detection ---

const summaryPath = process.env.BENCHMARK_SUMMARY ?? "/tmp/benchmark-summary.json";
await Bun.write(summaryPath, JSON.stringify({
  whisper_total: Math.round(wTotal * 10) / 10,
  parakeet_total: Math.round(pTotal * 10) / 10,
  speedup,
}));
