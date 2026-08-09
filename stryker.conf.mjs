// Mutation testing for the TypeScript side. A surviving mutant is a coverage gap stated as the
// exact edit no test noticed — this found `confidence < 0.5` never exercised at the boundary.
//
//   bunx stryker run                       # the pairing below
//   bunx stryker run --mutate src/foo.ts   # another file, with testFiles edited to match
//
// Scoped runs are fast: 44 mutants in ~1s, 1.3 tests per mutant, because `perTest` coverage
// re-runs only the covering tests rather than the suite.
//
// KNOWN LIMIT — the whole unit suite cannot be a `testFiles` glob. Either 30-file half runs
// clean; all 60 together die with "Failed to get inspector URL", so this is the runner's
// inspector handshake hitting a scale limit, not a bad test. Keep runs file-scoped.
export default {
  testRunner: "bun",
  // Stryker auto-loads only @stryker-mutator/*; this runner lives under another scope.
  plugins: ["@hughescr/stryker-bun-runner"],
  // Runs only the tests covering each mutant, instead of the whole suite per mutant.
  coverageAnalysis: "perTest",
  mutate: ["src/voice-routing.ts"],
  bun: {
    testFiles: ["tests/unit/voice-routing.test.ts"],
  },
  // TS 7 removed ts.parseConfigFileTextToJson, which Stryker's sandbox rewriter calls; point it away.
  tsconfigFile: "tsconfig.stryker-none.json",
  // The sandbox copy chokes on a unix socket in the Rust build dir, and would copy ~67k files.
  ignorePatterns: ["rust/target", ".worktrees", "raycast/node_modules", "dist", "mutants.out"],
  reporters: ["clear-text", "progress"],
  concurrency: 2,
  timeoutMS: 20000,
};
