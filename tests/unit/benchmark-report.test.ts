import { describe, test, expect } from "bun:test";
import {
  createBenchmarkSummary,
  renderBenchmarkReport,
  type BenchmarkSystemInfo,
} from "../../src/benchmark-report";

const system: BenchmarkSystemInfo = {
  os: "Darwin",
  arch: "arm64",
  chip: "Apple M3 Pro",
  ram: "18 GB",
  backend: "CoreML",
};

describe("benchmark-report", () => {
  test("createBenchmarkSummary computes totals and speedup", () => {
    expect(
      createBenchmarkSummary(
        [
          { time: 2.34, text: "a" },
          { time: 1.11, text: "b" },
        ],
        [
          { time: 1.0, text: "a" },
          { time: 0.5, text: "b" },
        ],
      ),
    ).toEqual({
      whisper_total: 3.5,
      parakeet_total: 1.5,
      speedup: 2.3,
    });
  });

  test("createBenchmarkSummary rejects mismatched result counts", () => {
    expect(() =>
      createBenchmarkSummary(
        [{ time: 1, text: "a" }],
        [
          { time: 1, text: "a" },
          { time: 2, text: "b" },
        ],
      ),
    ).toThrow("Benchmark result count mismatch");
  });

  test("renderBenchmarkReport produces markdown with totals", () => {
    const report = renderBenchmarkReport({
      date: "2026-04-08",
      version: "0.7.0",
      system,
      whisperResults: [{ time: 3.2, text: "hello" }],
      parakeetResults: [{ time: 1.6, text: "hello" }],
    });

    expect(report.summary).toEqual({
      whisper_total: 3.2,
      parakeet_total: 1.6,
      speedup: 2,
    });
    expect(report.markdown).toContain("**Date:** 2026-04-08");
    expect(report.markdown).toContain("**Runner:** Darwin arm64 (Apple M3 Pro, 18 GB RAM)");
    expect(report.markdown).toContain("| **Total** | **3.2s** | **1.6s** | | |");
    expect(report.markdown).toContain("**Kesha is ~2x faster.**");
  });
});
