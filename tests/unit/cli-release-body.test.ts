import { describe, expect, test } from "bun:test";
import { composeCliReleaseBody, previousStableCliTag } from "../../.github/scripts/cli-release-body.mjs";

describe("composeCliReleaseBody", () => {
  test("names both versions when the release moves the engine pin", () => {
    const body = composeCliReleaseBody({
      version: "1.27.0",
      engineVersion: "1.24.9",
      previousEngineVersion: "1.24.7",
    });

    expect(body).toContain("Engine: v1.24.7 → v1.24.9.");
    expect(body).not.toContain("unchanged");
  });

  test("says unchanged only when the previous release carried the same pin", () => {
    const body = composeCliReleaseBody({
      version: "1.27.1",
      engineVersion: "1.24.9",
      previousEngineVersion: "1.24.9",
    });

    expect(body).toContain("v1.27.1 (CLI-only). Engine: v1.24.9 (unchanged).");
  });

  // Nothing to compare against is not evidence that the pin held still.
  test("claims neither when there is no previous release to compare against", () => {
    const body = composeCliReleaseBody({ version: "1.0.0", engineVersion: "1.24.9" });

    expect(body).toContain("v1.0.0 (CLI-only). Engine: v1.24.9.");
    expect(body).not.toContain("unchanged");
    expect(body).not.toContain("→");
  });

  test("authored notes lead, and the computed engine line still lands under them", () => {
    const body = composeCliReleaseBody({
      version: "1.27.0",
      engineVersion: "1.24.9",
      previousEngineVersion: "1.24.7",
      notes: "## Highlights\n\n- `kesha record --live`\n",
    });

    expect(body.startsWith("## Highlights")).toBe(true);
    expect(body).toContain("- `kesha record --live`");
    expect(body.trimEnd().endsWith("v1.27.0 (CLI-only). Engine: v1.24.7 → v1.24.9.")).toBe(true);
  });

  test("a lightweight tag contributes no notes and leaves the generated line alone", () => {
    expect(composeCliReleaseBody({ version: "1.27.0", engineVersion: "1.24.9", notes: "  \n " })).toBe(
      "v1.27.0 (CLI-only). Engine: v1.24.9.\n",
    );
  });
});

describe("previousStableCliTag", () => {
  const tags = ["v1.25.0-cli", "v1.26.0-cli", "v1.27.0-cli", "v1.26.0", "v2.0.0-cli"];

  test("the baseline is the highest stable marker below the tag being released", () => {
    expect(previousStableCliTag("v1.27.0-cli", tags)).toBe("v1.26.0-cli");
  });

  // The baseline has to be something this lane actually published a body for.
  test.each(["v1.26.5-beta.1-cli", "v1.26.9-alpha.4-cli"])("%s is not a baseline", (prerelease) => {
    expect(previousStableCliTag("v1.27.0-cli", [...tags, prerelease])).toBe("v1.26.0-cli");
  });

  // A bare vX.Y.Z tag names the engine, not the CLI, and carries no CLI release body.
  test("an engine tag is not a baseline", () => {
    expect(previousStableCliTag("v1.26.0-cli", ["v1.26.0"])).toBeUndefined();
  });

  test("the first CLI release ever has no baseline", () => {
    expect(previousStableCliTag("v1.0.0-cli", [])).toBeUndefined();
  });

  test("a tag above the one being released is not a baseline", () => {
    expect(previousStableCliTag("v1.25.0-cli", ["v1.25.0-cli", "v1.26.0-cli"])).toBeUndefined();
  });

  test("tag lists arrive from git with trailing whitespace", () => {
    expect(previousStableCliTag("v1.27.0-cli", ["v1.26.0-cli\n", " v1.25.0-cli "])).toBe("v1.26.0-cli");
  });
});
