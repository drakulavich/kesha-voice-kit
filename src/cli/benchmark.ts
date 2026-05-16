import { defineCommand } from "citty";
import { Glob } from "bun";
import { basename, resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";

const DEFAULT_SAMPLE_SETS = "fixtures/benchmark,fixtures/benchmark-en";
const DEFAULT_RESULTS_FILE = "benchmark-results.json";
const DEFAULT_COREML_BIN = "/tmp/coreml-bench/parakeet-coreml";
const VENV_DIR = resolve(homedir(), ".cache", "kesha", "benchmark-venv");

const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json();

interface BenchmarkCommandArgs {
  "sample-set": string;
  "out-json": string;
  "coreml-bin": string;
}

export interface EngineResult {
  time: number;
  text: string;
}

export interface FileResult {
  file: string;
  openaiWhisper: EngineResult;
  fasterWhisper: EngineResult;
  kesha: EngineResult;
  keshaCoreml?: EngineResult;
}

export interface GroupResult {
  name: string;
  sampleSet: string;
  fileCount: number;
  results: FileResult[];
  totals: {
    openaiWhisper: number;
    fasterWhisper: number;
    kesha: number;
    keshaCoreml?: number;
  };
}

export interface BenchmarkReport {
  date: string;
  platform: { os: string; arch: string; chip: string; ram: string };
  profile: {
    packageVersion: string;
    bunVersion: string;
    keshaBackend: string;
    whisperModel: string;
    sampleSets: Array<{ name: string; path: string; fileCount: number }>;
  };
  keshaBackend: string;
  whisperModel: string;
  groups: GroupResult[];
}

export interface SampleSet {
  name: string;
  dir: string;
  files: string[];
}

interface RunBenchmarkOptions {
  repoDir?: string;
  sampleSetArg?: string;
  outJson?: string;
  coremlBin?: string;
  keshaCommand?: string[];
}

function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function titleFromPath(path: string): string {
  const base = basename(path);
  if (base === "benchmark") return "Russian";
  if (base === "benchmark-en") return "English";
  return base.replace(/^benchmark-?/, "").replace(/[-_]+/g, " ") || "sample";
}

function getSystemInfo(): BenchmarkReport["platform"] {
  const os = process.platform === "darwin" ? "Darwin" : process.platform === "linux" ? "Linux" : "Windows";
  const arch = process.arch;
  let chip = "Unknown";
  let ram = "Unknown";

  if (os === "Darwin") {
    chip = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"], { stdout: "pipe" }).stdout.toString().trim() || "Unknown";
    const profiler = Bun.spawnSync(["system_profiler", "SPHardwareDataType"], { stdout: "pipe" }).stdout.toString();
    ram = profiler.match(/Memory:\s+(.+)/)?.[1] ?? "Unknown";
  } else if (os === "Linux") {
    const lscpu = Bun.spawnSync(["lscpu"], { stdout: "pipe" }).stdout.toString();
    chip = lscpu.match(/Model name:\s+(.*)/)?.[1]?.trim() ?? "Unknown";
    const free = Bun.spawnSync(["free", "-h"], { stdout: "pipe" }).stdout.toString();
    ram = free.match(/Mem:\s+(\S+)/)?.[1] ?? "Unknown";
  }

  return { os, arch, chip, ram };
}

function getKeshaBackend(keshaCommand: string[]): string {
  const proc = Bun.spawnSync([...keshaCommand, "status"], { stdout: "pipe", stderr: "pipe" });
  const output = proc.stdout.toString();
  if (output.includes("coreml")) return "coreml";
  if (output.includes("onnx")) return "onnx";
  return "unknown";
}

function ensureVenv(): string {
  const python = resolve(VENV_DIR, "bin", "python3");
  const pip = resolve(VENV_DIR, "bin", "pip");

  if (existsSync(python)) {
    const check = Bun.spawnSync([python, "-c", "import whisper; import faster_whisper"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (check.exitCode === 0) return python;
  }

  console.error("Setting up Python venv for Whisper benchmarks...");
  mkdirSync(VENV_DIR, { recursive: true });

  const venvProc = Bun.spawnSync(["python3", "-m", "venv", VENV_DIR], { stdout: "pipe", stderr: "pipe" });
  if (venvProc.exitCode !== 0) {
    throw new Error(`Failed to create venv: ${venvProc.stderr.toString()}`);
  }

  console.error("Installing openai-whisper...");
  const whisperInstall = Bun.spawnSync([pip, "install", "-q", "openai-whisper"], { stdout: "pipe", stderr: "inherit" });
  if (whisperInstall.exitCode !== 0) throw new Error("Failed to install openai-whisper");

  console.error("Installing faster-whisper...");
  const fasterInstall = Bun.spawnSync([pip, "install", "-q", "faster-whisper"], { stdout: "pipe", stderr: "inherit" });
  if (fasterInstall.exitCode !== 0) throw new Error("Failed to install faster-whisper");

  console.error("Venv ready.\n");
  return python;
}

function scanFixtures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return [...new Glob("*.ogg").scanSync(dir)].sort().map((file) => resolve(dir, file));
}

export function resolveSampleSets(sampleSetArg = DEFAULT_SAMPLE_SETS, repoDir = resolve(import.meta.dir, "../..")): SampleSet[] {
  return splitCsv(sampleSetArg).map((entry) => {
    const dir = resolve(repoDir, entry);
    return {
      name: titleFromPath(entry),
      dir,
      files: scanFixtures(dir),
    };
  });
}

function runOpenAIWhisper(python: string, files: string[]): EngineResult[] {
  console.error(`Running openai-whisper (large-v3-turbo) on ${files.length} files...`);

  const script = `
import sys, time, json, whisper

model = whisper.load_model("large-v3-turbo")
results = []
total = len(sys.argv[1:])
for i, f in enumerate(sys.argv[1:], 1):
    name = f.split("/")[-1][:30]
    print(f"  [{i}/{total}] {name}...", end="", flush=True, file=sys.stderr)
    start = time.time()
    result = model.transcribe(f)
    elapsed = time.time() - start
    print(f" {elapsed:.1f}s", file=sys.stderr)
    results.append({"time": round(elapsed, 1), "text": result["text"].strip()})

print(json.dumps(results, ensure_ascii=False))
`;

  const proc = Bun.spawnSync([python, "-c", script, ...files], {
    stdout: "pipe",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) throw new Error("openai-whisper benchmark failed");
  return JSON.parse(proc.stdout.toString());
}

function runFasterWhisper(python: string, files: string[]): EngineResult[] {
  console.error(`Running faster-whisper (large-v3-turbo, int8) on ${files.length} files...`);

  const script = `
import sys, time, json
from faster_whisper import WhisperModel

model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")
results = []
total = len(sys.argv[1:])
for i, f in enumerate(sys.argv[1:], 1):
    name = f.split("/")[-1][:30]
    print(f"  [{i}/{total}] {name}...", end="", flush=True, file=sys.stderr)
    start = time.time()
    segments, info = model.transcribe(f)
    text = " ".join(s.text.strip() for s in segments)
    elapsed = time.time() - start
    print(f" {elapsed:.1f}s", file=sys.stderr)
    results.append({"time": round(elapsed, 1), "text": text})

print(json.dumps(results, ensure_ascii=False))
`;

  const proc = Bun.spawnSync([python, "-c", script, ...files], {
    stdout: "pipe",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) throw new Error("faster-whisper benchmark failed");
  return JSON.parse(proc.stdout.toString());
}

function runKesha(keshaCommand: string[], files: string[]): EngineResult[] {
  console.error(`Running Kesha on ${files.length} files...`);
  const results: EngineResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = basename(file).slice(0, 30);
    process.stderr.write(`  [${i + 1}/${files.length}] ${name}...`);

    const start = performance.now();
    const proc = Bun.spawnSync([...keshaCommand, file], { stdout: "pipe", stderr: "pipe" });
    const elapsed = (performance.now() - start) / 1000;

    if (proc.exitCode !== 0) {
      console.error(" FAILED");
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

function isCoremlAvailable(coremlBin: string): boolean {
  return process.platform === "darwin" && process.arch === "arm64" && existsSync(coremlBin);
}

function runKeshaCoreml(coremlBin: string, files: string[]): EngineResult[] {
  console.error(`Running Kesha CoreML on ${files.length} files...`);
  const results: EngineResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = basename(file).slice(0, 30);
    process.stderr.write(`  [${i + 1}/${files.length}] ${name}...`);

    const start = performance.now();
    const proc = Bun.spawnSync([coremlBin, file], { stdout: "pipe", stderr: "pipe" });
    const elapsed = (performance.now() - start) / 1000;

    if (proc.exitCode !== 0) {
      console.error(" FAILED");
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

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function sumTimes(results: EngineResult[]): number {
  return round1(results.reduce((sum, result) => sum + result.time, 0));
}

function renderGroup(group: GroupResult, hasCoreml: boolean): string[] {
  const coremlHeader = hasCoreml ? " Kesha CoreML |" : "";
  const coremlSep = hasCoreml ? "---|" : "";
  const lines: string[] = [
    `### ${group.name} (${group.fileCount} files)`,
    "",
    `Sample set: \`${group.sampleSet}\``,
    "",
    `| # | File | openai-whisper | faster-whisper | Kesha ONNX |${coremlHeader} Transcript (Kesha) |`,
    `|---|---|---|---|---|${coremlSep}---|`,
  ];

  for (let i = 0; i < group.results.length; i++) {
    const result = group.results[i];
    const transcript = result.kesha.text.slice(0, 60) + (result.kesha.text.length > 60 ? "..." : "");
    const coremlCol = hasCoreml && result.keshaCoreml ? ` ${result.keshaCoreml.time}s |` : "";
    lines.push(
      `| ${i + 1} | ${result.file} | ${result.openaiWhisper.time}s | ${result.fasterWhisper.time}s | ${result.kesha.time}s |${coremlCol} ${transcript} |`,
    );
  }

  const totals = group.totals;
  const coremlTotal = hasCoreml && totals.keshaCoreml != null ? ` **${totals.keshaCoreml}s** |` : "";
  lines.push(`| **Total** | | **${totals.openaiWhisper}s** | **${totals.fasterWhisper}s** | **${totals.kesha}s** |${coremlTotal} |`);
  lines.push("");

  const bestTime = hasCoreml && totals.keshaCoreml != null ? totals.keshaCoreml : totals.kesha;
  const bestLabel = hasCoreml && totals.keshaCoreml != null ? "Kesha CoreML" : "Kesha ONNX";
  const speedVsWhisper = bestTime > 0 ? round1(totals.openaiWhisper / bestTime) : 0;
  const speedVsFaster = bestTime > 0 ? round1(totals.fasterWhisper / bestTime) : 0;
  lines.push(
    `**Speedup:** ${bestLabel} is ~${speedVsWhisper}x faster than openai-whisper, ~${speedVsFaster}x faster than faster-whisper`,
  );

  return lines;
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const p = report.platform;
  const lines: string[] = [
    "## Benchmark: Speech-to-Text Engines",
    "",
    `**Date:** ${report.date}`,
    `**Platform:** ${p.os} ${p.arch} (${p.chip}, ${p.ram} RAM)`,
    `**Kesha package:** ${report.profile.packageVersion}`,
    `**Bun:** ${report.profile.bunVersion}`,
    `**Kesha backend:** ${report.profile.keshaBackend}`,
    `**Whisper model:** ${report.profile.whisperModel}`,
    `**openai-whisper** is the default transcription engine in OpenClaw.`,
    "",
  ];

  const hasCoreml = report.groups.some((group) => group.totals.keshaCoreml != null);
  for (const group of report.groups) {
    lines.push(...renderGroup(group, hasCoreml));
    lines.push("");
  }

  return lines.join("\n");
}

function currentKeshaCommand(): string[] {
  const entry = process.argv[1];
  if (!entry || entry.endsWith("scripts/benchmark.ts")) return ["kesha"];
  return [process.execPath, entry];
}

export async function runBenchmark(options: RunBenchmarkOptions = {}): Promise<BenchmarkReport> {
  const repoDir = options.repoDir ?? resolve(import.meta.dir, "../..");
  const outJson = options.outJson ?? DEFAULT_RESULTS_FILE;
  const coremlBin = options.coremlBin ?? DEFAULT_COREML_BIN;
  const keshaCommand = options.keshaCommand ?? currentKeshaCommand();
  const sampleSets = resolveSampleSets(options.sampleSetArg ?? DEFAULT_SAMPLE_SETS, repoDir);

  if (sampleSets.length === 0 || sampleSets.every((set) => set.files.length === 0)) {
    throw new Error(`No .ogg fixture files found for --sample-set ${options.sampleSetArg ?? DEFAULT_SAMPLE_SETS}`);
  }

  const platform = getSystemInfo();
  const keshaBackend = getKeshaBackend(keshaCommand);
  const python = ensureVenv();
  const groups: GroupResult[] = [];

  for (const sampleSet of sampleSets) {
    if (sampleSet.files.length === 0) continue;

    console.error(`\n--- ${sampleSet.name} (${sampleSet.files.length} files) ---\n`);

    const owResults = runOpenAIWhisper(python, sampleSet.files);
    const fwResults = runFasterWhisper(python, sampleSet.files);
    const kResults = runKesha(keshaCommand, sampleSet.files);
    const coremlResults = isCoremlAvailable(coremlBin) ? runKeshaCoreml(coremlBin, sampleSet.files) : null;

    const results: FileResult[] = sampleSet.files.map((file, i) => ({
      file: basename(file),
      openaiWhisper: owResults[i],
      fasterWhisper: fwResults[i],
      kesha: kResults[i],
      ...(coremlResults ? { keshaCoreml: coremlResults[i] } : {}),
    }));

    groups.push({
      name: sampleSet.name,
      sampleSet: sampleSet.dir,
      fileCount: sampleSet.files.length,
      results,
      totals: {
        openaiWhisper: sumTimes(owResults),
        fasterWhisper: sumTimes(fwResults),
        kesha: sumTimes(kResults),
        ...(coremlResults ? { keshaCoreml: sumTimes(coremlResults) } : {}),
      },
    });
  }

  const report: BenchmarkReport = {
    date: new Date().toISOString().split("T")[0],
    platform,
    profile: {
      packageVersion: typeof pkg.version === "string" ? pkg.version : "unknown",
      bunVersion: Bun.version,
      keshaBackend,
      whisperModel: "large-v3-turbo",
      sampleSets: sampleSets.map((set) => ({
        name: set.name,
        path: set.dir,
        fileCount: set.files.length,
      })),
    },
    keshaBackend,
    whisperModel: "large-v3-turbo",
    groups,
  };

  console.log(renderBenchmarkMarkdown(report));
  await Bun.write(outJson, JSON.stringify(report, null, 2));
  console.error(`\nJSON results written to ${outJson}`);
  return report;
}

export const benchmarkCommand = defineCommand({
  meta: {
    name: "benchmark",
    description: "Run reproducible STT benchmarks against openai-whisper, faster-whisper, and Kesha",
  },
  args: {
    "sample-set": {
      type: "string",
      description: "Comma-separated fixture directories containing .ogg files",
      default: DEFAULT_SAMPLE_SETS,
    },
    "out-json": {
      type: "string",
      description: "Path for machine-readable benchmark results with platform/profile metadata",
      default: DEFAULT_RESULTS_FILE,
    },
    "coreml-bin": {
      type: "string",
      description: "Optional standalone CoreML benchmark binary path",
      default: DEFAULT_COREML_BIN,
    },
  },
  async run({ args }: { args: BenchmarkCommandArgs }) {
    try {
      await runBenchmark({
        sampleSetArg: args["sample-set"],
        outJson: args["out-json"],
        coremlBin: args["coreml-bin"],
      });
    } catch (err: unknown) {
      console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
});
