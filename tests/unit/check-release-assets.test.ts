import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetProblems } from "../../.github/scripts/check-release-assets";
import { tempDir } from "../helpers/temp-dir";

const manifest = { assets: [{ name: "kesha-engine-linux-x64" }, { name: "SHA256SUMS" }, { name: "kesha-release-manifest.json" }] };
const sums = "a".repeat(64) + "  ./kesha-engine-linux-x64\n" + "b".repeat(64) + "  ./kesha-release-manifest.json\n";

describe("assetProblems", () => {
  test("a directory holding every manifest asset, each checksummed, passes", () => {
    expect(assetProblems(manifest, ["SHA256SUMS", "kesha-engine-linux-x64", "kesha-release-manifest.json"], sums)).toEqual([]);
  });

  test("an asset the manifest names but the build never produced fails, by name", () => {
    expect(assetProblems(manifest, ["SHA256SUMS", "kesha-release-manifest.json"], sums)).toEqual([
      "kesha-engine-linux-x64 is in the manifest but was not built",
    ]);
  });

  test("a file the manifest does not name fails rather than shipping unannounced", () => {
    const files = ["SHA256SUMS", "kesha-engine-linux-x64", "kesha-release-manifest.json", "stray.bin"];
    expect(assetProblems(manifest, files, sums)).toEqual(["stray.bin would be published but is not in the manifest"]);
  });

  test("an asset missing from SHA256SUMS fails", () => {
    const partial = "a".repeat(64) + "  ./kesha-engine-linux-x64\n";
    expect(assetProblems(manifest, ["SHA256SUMS", "kesha-engine-linux-x64", "kesha-release-manifest.json"], partial)).toEqual([
      "kesha-release-manifest.json is not listed in SHA256SUMS",
    ]);
  });
});

describe("check-release-assets.ts", () => {
  test("exits 1 and names the problem for an incomplete directory", () => {
    const dir = tempDir("release-assets-");
    writeFileSync(join(dir, "kesha-release-manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "SHA256SUMS"), sums);
    const run = Bun.spawnSync(["bun", ".github/scripts/check-release-assets.ts", dir]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("kesha-engine-linux-x64 is in the manifest but was not built");
  });
});
