// Mutation testing for the TypeScript side. A surviving mutant is a coverage gap stated as the
// exact edit no test noticed — this found `confidence < 0.5` never exercised at the boundary.
//
//   just mutants-ts src/foo.ts   # or scripts/, or .github/scripts/; the pairing below is the fallback
//
// Scoped runs are fast: 44 mutants in ~1s, 1.3 tests per mutant, because `perTest` coverage
// re-runs only the covering tests rather than the suite.
export default {
  testRunner: "bun",
  // Stryker auto-loads only @stryker-mutator/*; this runner lives under another scope.
  plugins: ["@hughescr/stryker-bun-runner"],
  // Runs only the tests covering each mutant, instead of the whole suite per mutant.
  coverageAnalysis: "perTest",
  mutate: ["src/voice-routing.ts"],
  bun: {
    testFiles: ["tests/unit/voice-routing.test.ts"],
    // Child ceiling (dry run gets it +30s); a mutant this kills scores as detected, so 10s inflates.
    timeout: 180_000,
  },
  // TS 7 removed ts.parseConfigFileTextToJson, which Stryker's sandbox rewriter calls; point it away.
  tsconfigFile: "tsconfig.stryker-none.json",
  // The sandbox copy chokes on a unix socket in the Rust build dir, and would copy ~67k files.
  ignorePatterns: ["rust/target", ".worktrees", "raycast/node_modules", "dist", "mutants.out"],
  reporters: ["clear-text", "progress"],
  concurrency: 2,
  timeoutMS: 20000,
};
