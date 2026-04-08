export interface BenchmarkSystemInfo {
  os: string;
  arch: string;
  chip: string;
  ram: string;
  backend: string;
}

export interface BenchmarkResult {
  time: number;
  text: string;
}

export interface BenchmarkSummary {
  whisper_total: number;
  parakeet_total: number;
  speedup: number;
}

export interface BenchmarkReport {
  markdown: string;
  summary: BenchmarkSummary;
}

function roundToTenths(value: number): number {
  return Math.round(value * 10) / 10;
}

export function createBenchmarkSummary(
  whisperResults: BenchmarkResult[],
  parakeetResults: BenchmarkResult[],
): BenchmarkSummary {
  if (whisperResults.length !== parakeetResults.length) {
    throw new Error(
      `Benchmark result count mismatch: faster-whisper=${whisperResults.length}, parakeet=${parakeetResults.length}`,
    );
  }

  const whisperTotal = roundToTenths(
    whisperResults.reduce((total, result) => total + result.time, 0),
  );
  const parakeetTotal = roundToTenths(
    parakeetResults.reduce((total, result) => total + result.time, 0),
  );

  return {
    whisper_total: whisperTotal,
    parakeet_total: parakeetTotal,
    speedup: parakeetTotal > 0 ? roundToTenths(whisperTotal / parakeetTotal) : 0,
  };
}

export function renderBenchmarkReport(args: {
  date: string;
  version: string;
  system: BenchmarkSystemInfo;
  whisperResults: BenchmarkResult[];
  parakeetResults: BenchmarkResult[];
}): BenchmarkReport {
  const { date, version, system, whisperResults, parakeetResults } = args;
  const summary = createBenchmarkSummary(whisperResults, parakeetResults);

  const lines: string[] = [
    "",
    `**Date:** ${date}`,
    `**Version:** v${version}`,
    `**Runner:** ${system.os} ${system.arch} (${system.chip}, ${system.ram} RAM)`,
    `**Backend:** ${system.backend}`,
    "",
    `| # | faster-whisper | Parakeet (${system.backend}) | faster-whisper Transcript | Parakeet Transcript |`,
    "|---|---------|----------|--------------------|---------------------|",
  ];

  for (let i = 0; i < whisperResults.length; i++) {
    const whisper = whisperResults[i];
    const parakeet = parakeetResults[i];
    lines.push(
      `| ${i + 1} | ${whisper.time}s | ${parakeet.time}s | ${whisper.text} | ${parakeet.text} |`,
    );
  }

  lines.push(
    `| **Total** | **${summary.whisper_total}s** | **${summary.parakeet_total}s** | | |`,
  );
  lines.push("");
  lines.push(`**Parakeet is ~${summary.speedup}x faster.**`);

  return {
    markdown: lines.join("\n"),
    summary,
  };
}
