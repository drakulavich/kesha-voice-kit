#!/usr/bin/env bun
import { runBenchmark } from "../src/cli/benchmark";

await runBenchmark({ keshaCommand: ["kesha"] }).catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
