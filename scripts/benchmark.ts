#!/usr/bin/env bun
/**
 * Benchmark: faster-whisper vs parakeet-cli
 * Cross-platform: CoreML on macOS arm64, ONNX elsewhere.
 * Outputs markdown to stdout, writes benchmark-summary.json.
 */

import { Glob } from "bun";
import { resolve } from "path";
import {
  renderBenchmarkReport,
  type BenchmarkResult,
  type BenchmarkSystemInfo,
} from "../src/benchmark-report";

const repoDir = resolve(import.meta.dir, "..");
const fixturesDir = resolve(repoDir, "fixtures/benchmark");
const CLI = "parakeet";
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

// --- System detection ---

function getSystemInfo(): BenchmarkSystemInfo {
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

function getBenchmarkFiles(): string[] {
  const files = [...new Glob("*.ogg").scanSync(fixturesDir)]
    .sort()
    .map((file) => resolve(fixturesDir, file));

  if (files.length === 0) {
    throw new Error(`No .ogg files found in ${fixturesDir}`);
  }

  return files;
}

function getCliVersion(): string {
  return Bun.spawnSync([CLI, "--version"], { stdout: "pipe" }).stdout.toString().trim() || "unknown";
}

async function ensureBackendInstalled(): Promise<void> {
  const { isModelInstalled } = await import("../src/models");
  if (!isModelInstalled()) {
    throw new Error("No backend installed. Run: parakeet install");
  }
}

function runWhisperBenchmark(files: string[]): BenchmarkResult[] {
  console.error(`Running faster-whisper benchmark (${files.length} files)...`);

  const whisperProc = Bun.spawnSync(["python3", "-c", whisperPython, ...files], {
    stdout: "pipe",
    stderr: "inherit",
  });
  if (whisperProc.exitCode !== 0) {
    throw new Error("faster-whisper benchmark failed");
  }

  return JSON.parse(whisperProc.stdout.toString()) as BenchmarkResult[];
}

function verifyParakeetCli(audioFile: string): void {
  console.error("Verifying parakeet transcription...");
  const testProc = Bun.spawnSync([CLI, audioFile], { stdout: "pipe", stderr: "pipe" });
  if (testProc.exitCode !== 0) {
    const detail = testProc.stderr.toString().trim();
    throw new Error(detail ? `Parakeet verification failed: ${detail}` : "Parakeet verification failed");
  }

  console.error(`Verification OK: "${testProc.stdout.toString().trim().slice(0, 50)}..."`);
}

function runParakeetBenchmark(files: string[]): BenchmarkResult[] {
  console.error(`Running parakeet benchmark (${files.length} files)...`);
  verifyParakeetCli(files[0]);

  const results: BenchmarkResult[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = file.split("/").pop()!.slice(0, 30);
    process.stderr.write(`  [${i + 1}/${files.length}] ${name}...`);
    const start = performance.now();
    const proc = Bun.spawnSync([CLI, file], { stdout: "pipe", stderr: "pipe" });
    const elapsed = (performance.now() - start) / 1000;

    if (proc.exitCode !== 0) {
      console.error(" FAILED");
      const detail = proc.stderr.toString().trim();
      if (detail) {
        console.error(detail);
      }
    } else {
      console.error(` ${elapsed.toFixed(1)}s`);
    }

    results.push({
      time: Math.round(elapsed * 10) / 10,
      text: proc.stdout.toString().trim(),
    });
  }

  return results;
}

async function writeBenchmarkSummary(summary: object): Promise<void> {
  const summaryPath = process.env.BENCHMARK_SUMMARY ?? "/tmp/benchmark-summary.json";
  await Bun.write(summaryPath, JSON.stringify(summary));
}

async function main(): Promise<void> {
  try {
    const files = getBenchmarkFiles();
    const system = getSystemInfo();
    const version = getCliVersion();

    await ensureBackendInstalled();

    const whisperResults = runWhisperBenchmark(files);
    const parakeetResults = runParakeetBenchmark(files);
    const report = renderBenchmarkReport({
      date: new Date().toISOString().split("T")[0],
      version,
      system,
      whisperResults,
      parakeetResults,
    });

    console.log(report.markdown);
    await writeBenchmarkSummary(report.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
}

await main();
