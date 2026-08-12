import { describe, expect, test } from "bun:test";

// Below this the whole-suite dry run is killed mid-flight and slow mutant runs score as detected.
const CHILD_CEILING_FLOOR_MS = 120_000;

interface StrykerConfig {
  bun?: { timeout?: number };
}

async function loadStrykerConfig(): Promise<StrykerConfig> {
  const href = new URL("../../stryker.conf.mjs", import.meta.url).href;
  const module_ = (await import(href)) as { default: StrykerConfig };
  return module_.default;
}

describe("stryker config", () => {
  test("pins the bun child-process ceiling above the suite's own runtime", async () => {
    const config = await loadStrykerConfig();

    expect(config.bun?.timeout).toBeGreaterThanOrEqual(CHILD_CEILING_FLOOR_MS);
  });
});
