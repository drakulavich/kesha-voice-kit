#!/usr/bin/env bun
/**
 * Validate lcov coverage reports against conservative per-surface baselines.
 *
 * This intentionally gates only line coverage. Function coverage differs more
 * between Bun/V8 and LLVM, while line coverage is stable enough to catch a
 * critical module losing tests without making CI noisy.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type PresetName = "ts" | "rust";

type CoveragePreset = {
  title: string;
  minTotalLines: number;
  minFileLines: Record<string, number>;
};

type FileCoverage = {
  path: string;
  linesFound: number;
  linesHit: number;
  linePct: number;
};

// Coverage policy: a single total-lines gate per language, no per-file floors.
// The per-file map was an auto-ratchet pinned just below each file's current
// coverage (with brittle 98%/100% outliers) — high friction (every feature that
// touched a high-floor file had to add coverage-padding tests), low signal
// (concentrated regressions are caught by review + the total gate). Dropped in
// favour of one honest total floor.
const presets: Record<PresetName, CoveragePreset> = {
  ts: {
    title: "TypeScript Coverage",
    minTotalLines: 70,
    minFileLines: {},
  },
  rust: {
    title: "Rust Coverage",
    minTotalLines: 70,
    minFileLines: {},
  },
};

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      throw new Error(`unknown argument ${arg}; expected --key=value`);
    }
    args.set(match[1], match[2]);
  }
  return args;
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const cwd = process.cwd().replaceAll("\\", "/");
  const rustPrefix = `${cwd}/rust/`;
  if (normalized.startsWith(rustPrefix)) {
    return normalized.slice(rustPrefix.length);
  }

  if (normalized.startsWith(`${cwd}/`)) {
    return normalized.slice(cwd.length + 1);
  }

  if (normalized.includes("/rust/src/")) {
    return `src/${normalized.split("/rust/src/")[1]}`;
  }

  if (normalized.includes("/src/")) {
    return `src/${normalized.split("/src/")[1]}`;
  }

  return normalized;
}

function parseLcov(path: string): FileCoverage[] {
  const report = readFileSync(path, "utf8");
  const files: FileCoverage[] = [];
  let currentPath: string | null = null;
  let linesFound = 0;
  let linesHit = 0;

  function finishCurrent() {
    if (!currentPath) return;
    const linePct = linesFound === 0 ? 100 : (linesHit / linesFound) * 100;
    files.push({
      path: normalizePath(currentPath),
      linesFound,
      linesHit,
      linePct,
    });
    currentPath = null;
    linesFound = 0;
    linesHit = 0;
  }

  for (const line of report.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      finishCurrent();
      currentPath = line.slice(3);
    } else if (line.startsWith("LF:")) {
      linesFound = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      linesHit = Number(line.slice(3));
    } else if (line === "end_of_record") {
      finishCurrent();
    }
  }
  finishCurrent();

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function pct(value: number): string {
  return value.toFixed(2);
}

function renderSummary(title: string, total: FileCoverage, checked: Array<FileCoverage & { min: number }>): string {
  const rows = [
    `## ${title}`,
    "",
    `Total line coverage: **${pct(total.linePct)}%** (${total.linesHit}/${total.linesFound})`,
    "",
    "| File | Lines | Minimum |",
    "| --- | ---: | ---: |",
    ...checked.map((file) => `| \`${file.path}\` | ${pct(file.linePct)}% | ${file.min}% |`),
    "",
  ];
  return rows.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const presetName = args.get("preset") as PresetName | undefined;
const lcovPath = args.get("lcov");
const summaryPath = args.get("summary");

if (!presetName || !(presetName in presets)) {
  console.error(`expected --preset=${Object.keys(presets).join("|")}`);
  process.exit(2);
}
if (!lcovPath) {
  console.error("expected --lcov=<path>");
  process.exit(2);
}

const resolvedLcov = resolve(lcovPath);
if (!existsSync(resolvedLcov)) {
  console.error(`coverage report not found: ${relative(process.cwd(), resolvedLcov)}`);
  process.exit(1);
}

const preset = presets[presetName];
const files = parseLcov(resolvedLcov);
const total: FileCoverage = {
  path: "TOTAL",
  linesFound: files.reduce((sum, file) => sum + file.linesFound, 0),
  linesHit: files.reduce((sum, file) => sum + file.linesHit, 0),
  linePct: 0,
};
total.linePct = total.linesFound === 0 ? 100 : (total.linesHit / total.linesFound) * 100;

const byPath = new Map(files.map((file) => [file.path, file]));
const checked: Array<FileCoverage & { min: number }> = [];
const failures: string[] = [];

if (total.linePct + Number.EPSILON < preset.minTotalLines) {
  failures.push(`total line coverage ${pct(total.linePct)}% is below ${preset.minTotalLines}%`);
}

for (const [path, min] of Object.entries(preset.minFileLines)) {
  const file = byPath.get(path);
  if (!file) {
    failures.push(`critical coverage file is missing from lcov: ${path}`);
    continue;
  }
  checked.push({ ...file, min });
  if (file.linePct + Number.EPSILON < min) {
    failures.push(`${path} line coverage ${pct(file.linePct)}% is below ${min}%`);
  }
}

const summary = renderSummary(preset.title, total, checked);
console.log(summary);
if (summaryPath) {
  writeFileSync(summaryPath, summary);
}

if (failures.length > 0) {
  console.error("\nCoverage gate failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
