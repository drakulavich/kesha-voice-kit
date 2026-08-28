import { describe, expect, test } from "bun:test";
import { buildUpdatedFormula } from "../../.github/scripts/update-homebrew-tap.mjs";
import { readRepoFile } from "../helpers/repo";

const FORMULA = readRepoFile("packaging/homebrew/Formula/kesha-voice-kit.rb");

function fetchReturning(version: string) {
  return async (url: string) =>
    url.endsWith("package.json")
      ? new Response(JSON.stringify({ version }))
      : new Response(Buffer.from("fake tarball"));
}

describe("buildUpdatedFormula", () => {
  test("shape (i): pins version from the tagged package.json, not the tag string", async () => {
    const out = await buildUpdatedFormula({
      tag: "v1.24.9",
      formula: FORMULA,
      fetchImpl: fetchReturning("1.27.0"),
    });

    expect(out).toContain('version "1.27.0"');
    expect(out).not.toContain('version "1.24.9"');
  });

  test("shape (ii): a second release replaces the prior release's version line, not duplicates it", async () => {
    const first = await buildUpdatedFormula({
      tag: "v1.24.9",
      formula: FORMULA,
      fetchImpl: fetchReturning("1.27.0"),
    });
    const second = await buildUpdatedFormula({
      tag: "v1.24.10",
      formula: first,
      fetchImpl: fetchReturning("1.28.0"),
    });

    expect(second.match(/^  version /gm)).toHaveLength(1);
    expect(second).toContain('version "1.28.0"');
    expect(second).not.toContain('version "1.27.0"');
  });

  test("shape (iii): omits the version line when the tag and the CLI version happen to match", async () => {
    const out = await buildUpdatedFormula({
      tag: "v1.24.7",
      formula: FORMULA,
      fetchImpl: fetchReturning("1.24.7"),
    });

    expect(out).not.toMatch(/^  version /m);
  });

  test("rejects a non-stable tag before fetching anything", async () => {
    await expect(
      buildUpdatedFormula({
        tag: "v1.24.9-cli",
        formula: FORMULA,
        fetchImpl: () => {
          throw new Error("must not fetch for a rejected tag");
        },
      }),
    ).rejects.toThrow(/stable/i);
  });
});
