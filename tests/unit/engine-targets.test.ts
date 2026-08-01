import { describe, expect, test } from "bun:test";
import { engineTarget, engineTargetKeys } from "../../src/engine-targets";
import { getEngineBinaryName } from "../../src/engine-install";
import { defaultBackendForPlatform } from "../../src/cli/install";

describe("engine targets are one table (#216)", () => {
  test("every shipped platform is complete", () => {
    for (const key of engineTargetKeys()) {
      const [platform, arch] = key.split("-");
      const target = engineTarget(platform, arch);
      expect(target).not.toBeNull();
      expect(target!.assetName).toMatch(/^kesha-engine-/);
      expect(["coreml", "onnx"]).toContain(target!.backend);
      expect(target!.sizeBytes).toBeGreaterThan(1_000_000);
    }
  });

  test("unshipped platforms resolve to null", () => {
    expect(engineTarget("darwin", "x64")).toBeNull();
    expect(engineTarget("linux", "arm64")).toBeNull();
    expect(engineTarget("win32", "arm64")).toBeNull();
    expect(engineTarget("freebsd", "x64")).toBeNull();
  });

  // The four call sites disagreeing is the failure #216 hit: one platform, four hand-edited
  // chains, and nothing asserting they agreed.
  test("the consumers read the table rather than their own copy", () => {
    for (const key of engineTargetKeys()) {
      const [platform, arch] = key.split("-");
      const target = engineTarget(platform, arch)!;
      expect(getEngineBinaryName(platform, arch)).toBe(target.assetName);
      expect(defaultBackendForPlatform(platform, arch)).toBe(target.backend);
    }
  });

  test("only Windows assets carry an executable suffix", () => {
    for (const key of engineTargetKeys()) {
      const [platform, arch] = key.split("-");
      const { assetName } = engineTarget(platform, arch)!;
      expect(assetName.endsWith(".exe")).toBe(platform === "win32");
    }
  });
});
