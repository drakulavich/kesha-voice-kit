// Mutation testing for the TypeScript side. A surviving mutant is a coverage gap stated as the
// exact edit no test noticed — this found `confidence < 0.5` never exercised at the boundary.
//
//   bunx stryker run                       # the pairing below
//   bunx stryker run --mutate src/foo.ts   # another file, with testFiles edited to match
//
// Scoped runs are fast: 44 mutants in ~1s, 1.3 tests per mutant, because `perTest` coverage
// re-runs only the covering tests rather than the suite.
//
// KNOWN LIMIT — `testFiles` cannot be a whole-suite glob. Measured: either 30-file half of
// tests/unit passes; all 60 together wait out the full inspectorTimeout and fail with "Failed to
// get inspector URL", so the process is alive and the URL never arrives. Cause unconfirmed;
// NO_COLOR/FORCE_COLOR (shell and bun.env) and a 60s timeout were tried and change nothing.
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
