import { describe, expect, test } from "bun:test";
import { normaliseReport, truncateToMajorMinor } from "../../.github/scripts/upload-flakiness";

function macos(osVersion: string, name = "bun") {
  return {
    name,
    systemData: { osName: "macos", osVersion, osArch: "arm64" },
    metadata: undefined as Record<string, unknown> | undefined,
  };
}

describe("truncateToMajorMinor", () => {
  test("drops the patch component", () => {
    expect(truncateToMajorMinor("26.5.2")).toBe("26.5");
    expect(truncateToMajorMinor("15.7.4")).toBe("15.7");
  });

  test("passes an already-truncated version through unchanged", () => {
    expect(truncateToMajorMinor("26.5")).toBe("26.5");
  });

  test("rejects a version with no minor component", () => {
    expect(() => truncateToMajorMinor("26")).toThrow(/expected at least major.minor/);
  });
});

describe("normaliseReport", () => {
  test("collapses the patch-level forks that fragmented history", () => {
    const report = { environments: [macos("15.7.4"), macos("15.7.5"), macos("15.7.7")] };
    normaliseReport(report);
    expect(report.environments.map((e) => e.systemData.osVersion)).toEqual(["15.7", "15.7", "15.7"]);
  });

  test("rewrites every environment, not just the first", () => {
    const report = { environments: [macos("26.5.2", "bun"), macos("26.5.2", "rust")] };
    expect(normaliseReport(report).normalised).toBe(2);
  });

  test("preserves the untruncated version in metadata", () => {
    const report = { environments: [macos("26.5.2")] };
    normaliseReport(report);
    expect(report.environments[0].metadata).toEqual({ osVersionFull: "26.5.2" });
  });

  test("matches osName case-insensitively", () => {
    const report = { environments: [{ systemData: { osName: "macOS", osVersion: "26.5.2" } }] };
    expect(normaliseReport(report).normalised).toBe(1);
  });

  test("leaves ubuntu and windows untouched", () => {
    const report = {
      environments: [
        { systemData: { osName: "ubuntu", osVersion: "24.04" } },
        { systemData: { osName: "win", osVersion: "10.0.26100" } },
      ],
    };
    const { normalised, skipped } = normaliseReport(report);
    expect(normalised).toBe(0);
    expect(skipped).toBe(2);
    expect(report.environments[1].systemData.osVersion).toBe("10.0.26100");
  });

  // Uploads run under `continue-on-error: true`, so these must fail loudly
  // rather than silently shipping an unnormalised report.
  test("throws on an empty environment list", () => {
    expect(() => normaliseReport({ environments: [] })).toThrow(/no environments/);
  });

  test("throws when a macOS environment carries no version", () => {
    expect(() => normaliseReport({ environments: [{ systemData: { osName: "macos" } }] })).toThrow(/no osVersion/);
  });

  test("throws on an unparseable macOS version", () => {
    expect(() => normaliseReport({ environments: [macos("sequoia")] })).toThrow(/unparseable/);
  });
});
