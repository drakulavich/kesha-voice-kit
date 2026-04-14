# Three-Way Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current benchmark script with a three-way comparison: openai-whisper (OpenClaw default) vs faster-whisper vs Kesha.

**Architecture:** Single `scripts/benchmark.ts` that manages a Python venv for both Whisper variants, runs all three engines on Russian + English fixtures, outputs markdown to stdout and JSON to file.

**Tech Stack:** TypeScript (Bun), Python (openai-whisper, faster-whisper), Kesha CLI

**Spec:** `docs/superpowers/specs/2026-04-14-benchmark-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/benchmark.ts` | Rewrite | Three-way benchmark runner |
| `Makefile` | Modify | Replace `benchmark-coreml` with `benchmark` |
| `src/benchmark-report.ts` | Delete | Replaced by inline report in benchmark script |
| `scripts/benchmark-coreml.ts` | Delete | Obsolete WhisperKit comparison |
| `tests/unit/benchmark-report.test.ts` | Delete | Tests for deleted module |
| `.github/workflows/benchmark.yml` | Delete | Benchmark is local-only |
| `fixtures/benchmark-en/` | Create | English audio fixtures |

---

### Task 1: Delete obsolete files

**Files:**
- Delete: `scripts/benchmark-coreml.ts`
- Delete: `src/benchmark-report.ts`
- Delete: `tests/unit/benchmark-report.test.ts`
- Delete: `.github/workflows/benchmark.yml`

- [ ] **Step 1: Delete files**

```bash
git rm scripts/benchmark-coreml.ts src/benchmark-report.ts tests/unit/benchmark-report.test.ts .github/workflows/benchmark.yml
```

- [ ] **Step 2: Verify tests still pass**

```bash
bun test tests/unit/
```

Expected: All pass (removed test file should reduce count, no failures).

- [ ] **Step 3: Verify type check**

```bash
bunx tsc --noEmit
```

Expected: Clean. If `benchmark-report.ts` is imported elsewhere, fix the import.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove obsolete benchmark-coreml, benchmark-report, and CI workflow"
```

---

### Task 2: Add English audio fixtures

**Files:**
- Create: `fixtures/benchmark-en/` directory with 5-10 short English audio clips

- [ ] **Step 1: Download English clips from Common Voice or LibriSpeech**

Option A — Common Voice (Mozilla, CC-0 license):
```bash
mkdir -p fixtures/benchmark-en
# Download a few clips from Common Voice dataset
# Or record short English phrases yourself
```

Option B — Use macOS `say` command to generate test audio:
```bash
mkdir -p fixtures/benchmark-en
say -o /tmp/en1.aiff "Please check your email and get back to me as soon as possible"
ffmpeg -i /tmp/en1.aiff fixtures/benchmark-en/01-check-email.ogg
say -o /tmp/en2.aiff "The meeting has been rescheduled to next Tuesday at three pm"
ffmpeg -i /tmp/en2.aiff fixtures/benchmark-en/02-meeting-rescheduled.ogg
say -o /tmp/en3.aiff "I need you to review the pull request before we can merge it"
ffmpeg -i /tmp/en3.aiff fixtures/benchmark-en/03-review-pr.ogg
say -o /tmp/en4.aiff "Can you deploy the latest changes to the staging environment"
ffmpeg -i /tmp/en4.aiff fixtures/benchmark-en/04-deploy-staging.ogg
say -o /tmp/en5.aiff "The database migration failed we need to rollback immediately"
ffmpeg -i /tmp/en5.aiff fixtures/benchmark-en/05-db-rollback.ogg
```

Note: TTS-generated audio is not ideal for benchmarking real-world performance. Real voice recordings from Common Voice or LibriSpeech are preferred. The `say` approach works as a placeholder until real clips are sourced.

- [ ] **Step 2: Verify files exist and are playable**

```bash
ls -lh fixtures/benchmark-en/*.ogg
```

- [ ] **Step 3: Commit**

```bash
git add fixtures/benchmark-en/
git commit -m "feat: add English benchmark fixtures"
```

---

### Task 3: Rewrite benchmark script

**Files:**
- Rewrite: `scripts/benchmark.ts`

- [ ] **Step 1: Write the new benchmark script**

```typescript
#!/usr/bin/env bun
/**
 * Benchmark: openai-whisper vs faster-whisper vs Kesha Voice Kit
 * Runs all three engines on Russian + English fixtures.
 * Output: markdown to stdout, JSON to benchmark-results.json.
 */

import { Glob } from "bun";
import { resolve, basename } from "path";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";

const CLI = "kesha";
const VENV_DIR = resolve(homedir(), ".cache", "kesha", "benchmark-venv");
const RESULTS_FILE = "benchmark-results.json";

// --- Types ---

interface EngineResult {
  time: number;
  text: string;
}

interface FileResult {
  file: string;
  openaiWhisper: EngineResult;
  fasterWhisper: EngineResult;
  kesha: EngineResult;
}

interface GroupResult {
  name: string;
  results: FileResult[];
  totals: { openaiWhisper: number; fasterWhisper: number; kesha: number };
}

interface BenchmarkReport {
  date: string;
  platform: { os: string; arch: string; chip: string; ram: string };
  keshaBackend: string;
  whisperModel: string;
  groups: GroupResult[];
}

// --- System detection ---

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

function getKeshaBackend(): string {
  const proc = Bun.spawnSync([CLI, "status"], { stdout: "pipe", stderr: "pipe" });
  const output = proc.stdout.toString();
  if (output.includes("coreml")) return "coreml";
  if (output.includes("onnx")) return "onnx";
  return "unknown";
}

// --- Python venv management ---

function ensureVenv(): string {
  const python = resolve(VENV_DIR, "bin", "python3");
  const pip = resolve(VENV_DIR, "bin", "pip");

  if (existsSync(python)) {
    // Check if packages are installed
    const check = Bun.spawnSync([python, "-c", "import whisper; import faster_whisper"], {
      stdout: "pipe", stderr: "pipe",
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

// --- Fixture scanning ---

function scanFixtures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return [...new Glob("*.ogg").scanSync(dir)].sort().map((f) => resolve(dir, f));
}

// --- Engine runners ---

function runOpenAIWhisper(python: string, files: string[]): EngineResult[] {
  console.error(`Running openai-whisper (base) on ${files.length} files...`);

  const script = `
import sys, time, json, whisper

model = whisper.load_model("base")
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
    stdout: "pipe", stderr: "inherit",
  });
  if (proc.exitCode !== 0) throw new Error("openai-whisper benchmark failed");
  return JSON.parse(proc.stdout.toString());
}

function runFasterWhisper(python: string, files: string[]): EngineResult[] {
  console.error(`Running faster-whisper (base, int8) on ${files.length} files...`);

  const script = `
import sys, time, json
from faster_whisper import WhisperModel

model = WhisperModel("base", device="cpu", compute_type="int8")
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
    stdout: "pipe", stderr: "inherit",
  });
  if (proc.exitCode !== 0) throw new Error("faster-whisper benchmark failed");
  return JSON.parse(proc.stdout.toString());
}

function runKesha(files: string[]): EngineResult[] {
  console.error(`Running Kesha on ${files.length} files...`);
  const results: EngineResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = basename(file).slice(0, 30);
    process.stderr.write(`  [${i + 1}/${files.length}] ${name}...`);

    const start = performance.now();
    const proc = Bun.spawnSync([CLI, file], { stdout: "pipe", stderr: "pipe" });
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

// --- Report rendering ---

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function sumTimes(results: EngineResult[]): number {
  return round1(results.reduce((sum, r) => sum + r.time, 0));
}

function renderGroup(group: GroupResult): string[] {
  const lines: string[] = [
    `### ${group.name} (${group.results.length} files)`,
    "",
    "| # | File | openai-whisper | faster-whisper | Kesha | Transcript (Kesha) |",
    "|---|---|---|---|---|---|",
  ];

  for (let i = 0; i < group.results.length; i++) {
    const r = group.results[i];
    const transcript = r.kesha.text.slice(0, 60) + (r.kesha.text.length > 60 ? "..." : "");
    lines.push(
      `| ${i + 1} | ${r.file} | ${r.openaiWhisper.time}s | ${r.fasterWhisper.time}s | ${r.kesha.time}s | ${transcript} |`,
    );
  }

  const t = group.totals;
  lines.push(`| **Total** | | **${t.openaiWhisper}s** | **${t.fasterWhisper}s** | **${t.kesha}s** | |`);
  lines.push("");

  const speedVsWhisper = t.kesha > 0 ? round1(t.openaiWhisper / t.kesha) : 0;
  const speedVsFaster = t.kesha > 0 ? round1(t.fasterWhisper / t.kesha) : 0;
  lines.push(
    `**Speedup:** Kesha is ~${speedVsWhisper}x faster than openai-whisper, ~${speedVsFaster}x faster than faster-whisper`,
  );

  return lines;
}

function renderMarkdown(report: BenchmarkReport): string {
  const p = report.platform;
  const lines: string[] = [
    "## Benchmark: Speech-to-Text Engines",
    "",
    `**Date:** ${report.date}`,
    `**Platform:** ${p.os} ${p.arch} (${p.chip}, ${p.ram} RAM)`,
    `**Kesha backend:** ${report.keshaBackend}`,
    `**Whisper model:** ${report.whisperModel}`,
    `**openai-whisper** is the default transcription engine in OpenClaw.`,
    "",
  ];

  for (const group of report.groups) {
    lines.push(...renderGroup(group));
    lines.push("");
  }

  return lines.join("\n");
}

// --- Main ---

async function main(): Promise<void> {
  const repoDir = resolve(import.meta.dir, "..");
  const ruFiles = scanFixtures(resolve(repoDir, "fixtures/benchmark"));
  const enFiles = scanFixtures(resolve(repoDir, "fixtures/benchmark-en"));

  if (ruFiles.length === 0 && enFiles.length === 0) {
    throw new Error("No fixture files found");
  }

  const platform = getSystemInfo();
  const keshaBackend = getKeshaBackend();
  const python = ensureVenv();

  const groups: GroupResult[] = [];

  for (const [name, files] of [["Russian", ruFiles], ["English", enFiles]] as const) {
    if (files.length === 0) continue;

    console.error(`\n--- ${name} (${files.length} files) ---\n`);

    const owResults = runOpenAIWhisper(python, files);
    const fwResults = runFasterWhisper(python, files);
    const kResults = runKesha(files);

    const results: FileResult[] = files.map((f, i) => ({
      file: basename(f),
      openaiWhisper: owResults[i],
      fasterWhisper: fwResults[i],
      kesha: kResults[i],
    }));

    groups.push({
      name,
      results,
      totals: {
        openaiWhisper: sumTimes(owResults),
        fasterWhisper: sumTimes(fwResults),
        kesha: sumTimes(kResults),
      },
    });
  }

  const report: BenchmarkReport = {
    date: new Date().toISOString().split("T")[0],
    platform,
    keshaBackend,
    whisperModel: "base",
    groups,
  };

  console.log(renderMarkdown(report));
  await Bun.write(RESULTS_FILE, JSON.stringify(report, null, 2));
  console.error(`\nJSON results written to ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it compiles**

```bash
bunx tsc --noEmit
```

Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add scripts/benchmark.ts
git commit -m "feat: rewrite benchmark — three-way openai-whisper vs faster-whisper vs Kesha"
```

---

### Task 4: Update Makefile

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Replace `benchmark-coreml` with `benchmark`**

Remove:
```makefile
benchmark-coreml: ## Run CoreML vs CoreML benchmark (macOS only)
	bun scripts/benchmark-coreml.ts
```

Add:
```makefile
benchmark: ## Run benchmark (openai-whisper vs faster-whisper vs Kesha)
	bun scripts/benchmark.ts
```

- [ ] **Step 2: Commit**

```bash
git add Makefile
git commit -m "chore: replace benchmark-coreml with benchmark in Makefile"
```

---

### Task 5: Run benchmark and verify

- [ ] **Step 1: Ensure Kesha engine is installed**

```bash
kesha status
```

Expected: Engine binary installed, backend shown.

- [ ] **Step 2: Run benchmark on Russian fixtures**

```bash
make benchmark
```

Expected: Three engines run sequentially, markdown table printed to stdout, `benchmark-results.json` created.

- [ ] **Step 3: Verify JSON output**

```bash
cat benchmark-results.json | python3 -m json.tool | head -20
```

Expected: Valid JSON with date, platform, groups, totals.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix: address benchmark integration findings"
```
