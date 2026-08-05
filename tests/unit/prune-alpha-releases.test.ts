import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prunable, RETENTION_DAYS } from "../../.github/scripts/prune-alpha-releases";

const NOW = new Date("2026-08-05T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const release = (tagName: string, age: number, isDraft = false) => ({
  tagName,
  publishedAt: daysAgo(age),
  isDraft,
});

describe("prunable", () => {
  test("takes alpha releases past the window", () => {
    expect(prunable([release("v1.24.8-alpha.1", RETENTION_DAYS + 1)], NOW)).toEqual([
      "v1.24.8-alpha.1",
    ]);
  });

  test("leaves an alpha inside the window", () => {
    expect(prunable([release("v1.24.8-alpha.1", RETENTION_DAYS - 1)], NOW)).toEqual([]);
  });

  // The whole point of the window: an old stable release must survive it.
  test("never takes a stable or beta release, however old", () => {
    const old = 10 * 365;
    expect(
      prunable([release("v1.0.0", old), release("v1.0.0-beta.1", old), release("v1.0.0-cli", old)], NOW),
    ).toEqual([]);
  });

  test("leaves a draft alone", () => {
    expect(prunable([release("v1.24.8-alpha.2", RETENTION_DAYS + 5, true)], NOW)).toEqual([]);
  });

  test("leaves a release that was never published", () => {
    expect(prunable([{ tagName: "v1.24.8-alpha.3", publishedAt: null, isDraft: false }], NOW)).toEqual([]);
  });

  // A CLI alpha is a different artifact; the selector must anchor, not merely contain "alpha".
  test("never takes a CLI alpha, however old", () => {
    expect(prunable([release("v1.27.0-alpha.1-cli", RETENTION_DAYS + 100)], NOW)).toEqual([]);
  });

  test("keeps a release on the day it reaches the window", () => {
    expect(prunable([release("v1.24.8-alpha.1", RETENTION_DAYS)], NOW)).toEqual([]);
  });

  test("refuses a release whose draft flag is missing rather than assuming it is published", () => {
    const noFlag = { tagName: "v1.24.8-alpha.5", publishedAt: daysAgo(RETENTION_DAYS + 1) };
    expect(() => prunable([noFlag as never], NOW)).toThrow(/no isDraft flag/);
  });

  // Silently keeping it would read as "nothing aged out" on every future run.
  test("refuses a date it cannot parse rather than skipping the release", () => {
    expect(() =>
      prunable([{ tagName: "v1.24.8-alpha.4", publishedAt: "soon", isDraft: false }], NOW),
    ).toThrow(
      /unparsable publishedAt/,
    );
  });

  test("selects only the aged ones out of a mixed list", () => {
    const releases = [
      release("v1.26.0-cli", 400),
      release("v1.24.8-alpha.1", RETENTION_DAYS + 2),
      release("v1.24.8-alpha.2", 1),
      release("v1.24.7", 60),
    ];

    expect(prunable(releases, NOW)).toEqual(["v1.24.8-alpha.1"]);
  });
});

describe("the pruning workflow", () => {
  const script = readFileSync(`${import.meta.dir}/../../.github/scripts/prune-alpha-releases.sh`, "utf8");

  // --cleanup-tag would free a version identifier for reuse, which the spec forbids.
  test("deletes the Release without touching its tag", () => {
    expect(script).toMatch(/^\s*gh release delete "\$tag" --yes$/m);
  });

  // A silent truncation would hide exactly the oldest releases, which are the prunable ones.
  test("refuses to prune from a truncated listing", () => {
    expect(script).toMatch(/-ge "\$LIMIT"/);
    expect(script).toContain("::error::");
  });
});
