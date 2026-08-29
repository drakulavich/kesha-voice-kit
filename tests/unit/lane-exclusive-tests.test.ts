import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRepoYaml } from "../helpers/repo";

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOW = ".github/workflows/rust-test.yml";

// Modules `cfg`-gated to features only `coreml-regression` builds: every other lane either
// compiles default features, so these are gated out, or stops at cargo check / clippy. A
// `#[test]` here that the lane's filter does not select executes in no lane at all (#951, #1072).
const LANE_EXCLUSIVE = ["rust/src/fluid_stdout.rs", "rust/src/transcribe/diarize.rs"] as const;

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function laneFilter(): string {
  const match = /-E '([^']+)'/.exec(read(WORKFLOW));
  expect(match).not.toBeNull();
  return match![1]!;
}

function testNames(source: string): string[] {
  return [...source.matchAll(/#\[test\]\s*(?:\n\s*#\[[^\]]*\]\s*)*\n\s*fn\s+([a-z0-9_]+)/g)].map((m) => m[1]!);
}

function modulePath(relative: string): string {
  return relative.replace(/^rust\/src\//, "").replace(/\.rs$/, "").replace(/\//g, "::");
}

describe("a lane-exclusive test cannot run nowhere", () => {
  test("the modules really are gated to that lane's features", () => {
    const lib = read("rust/src/lib.rs");
    // If the gating ever widens, this file's premise is gone and its list must be revisited.
    expect(lib).toContain("mod fluid_stdout;");
    expect(/#\[cfg\(all\(\s*target_os = "macos",[\s\S]{0,200}?mod fluid_stdout;/.test(lib)).toBe(true);
  });

  test("every test in a lane-exclusive module is selected by the lane", () => {
    const filter = laneFilter();
    const orphans: string[] = [];
    for (const relative of LANE_EXCLUSIVE) {
      const selectedByModule = filter.includes(`test(${modulePath(relative)}::)`);
      for (const name of testNames(read(relative))) {
        if (!selectedByModule && !filter.includes(`test(${name})`)) orphans.push(`${modulePath(relative)}::${name}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  test("every name the lane selects still exists", () => {
    const named = [...laneFilter().matchAll(/test\(([a-z0-9_]+)\)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    const sources = ["rust/src/backend/fluidaudio.rs", ...LANE_EXCLUSIVE].map((relative) => read(relative)).join("\n");
    // A rename that empties the lane must fail here rather than quietly select nothing.
    for (const name of named) expect(sources).toContain(`fn ${name}`);
  });
});

describe("the darwin-only unit tests have a lane", () => {
  // 14 unit cases assert only on darwin (#1105); the other unit lane is ubuntu-only, so this leg is where they assert.
  const unitTests = () => parseRepoYaml(".github/workflows/ci.yml").jobs["unit-tests"];

  test("the matrix keeps a macOS runner it does not exclude", () => {
    const job = unitTests();
    expect(job["runs-on"]).toBe("${{ matrix.os }}");
    const runners: string[] = job.strategy.matrix.os;
    // Intel macOS carries `-large` or `-intel`; bare and `-xlarge` labels are arm64, which is what the gated cases need.
    const arm64Macos = (r: string) => r.startsWith("macos") && !r.endsWith("-large") && !r.endsWith("-intel");
    expect(runners.filter(arm64Macos)).not.toEqual([]);
    expect(job.strategy.matrix.exclude).toBeUndefined();
  });

  test("the step that runs the unit suite is not conditioned off a row", () => {
    const steps = unitTests().steps.filter(
      (s: { run?: string }) => typeof s.run === "string" && s.run.includes("test:unit"),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBeUndefined();
  });
});
