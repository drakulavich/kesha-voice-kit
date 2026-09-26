import { describe, expect, test } from "bun:test";
import { engineTarget, engineTargetEntries, PINNED_ASSET_SHA256 } from "../../src/engine-targets";
import { getEngineBinaryName, SIDECARS } from "../../src/engine-install";
import { defaultBackendForPlatform } from "../../src/cli/install";

describe("engine targets are one table (#216)", () => {
  // Pinned, not shape-checked: `backend` decides which release asset a platform installs, so a
  // silent flip is the failure the four scattered tables made possible. Sizes are deliberately
  // absent — check-engine-targets.ts verifies those against the release, which a literal cannot.
  test("each platform is pinned to its backend and asset", () => {
    expect(engineTarget("darwin", "arm64")).toMatchObject({
      assetName: "kesha-engine-darwin-arm64",
      backend: "coreml",
    });
    expect(engineTarget("linux", "x64")).toMatchObject({
      assetName: "kesha-engine-linux-x64",
      backend: "onnx",
    });
    expect(engineTarget("win32", "x64")).toMatchObject({
      assetName: "kesha-engine-windows-x64.exe",
      backend: "onnx",
    });
  });

  // A download with no pin falls back to the release's own SHA256SUMS, which an attacker who can replace the asset can replace too.
  test("every asset the installer downloads has a pinned SHA-256, and nothing else does", () => {
    const downloaded = [
      ...engineTargetEntries().map(({ target }) => target.assetName),
      ...SIDECARS.map((s) => s.assetName),
    ].sort();
    expect(Object.keys(PINNED_ASSET_SHA256).sort()).toEqual(downloaded);
    for (const sha of Object.values(PINNED_ASSET_SHA256)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  test("unshipped platforms resolve to null", () => {
    expect(engineTarget("darwin", "x64")).toBeNull();
    expect(engineTarget("linux", "arm64")).toBeNull();
    expect(engineTarget("win32", "arm64")).toBeNull();
    expect(engineTarget("freebsd", "x64")).toBeNull();
  });

  test("entries round-trip back to the rows they came from", () => {
    const entries = engineTargetEntries();
    expect(entries).toHaveLength(3);
    for (const { platform, arch, target } of entries) {
      expect(engineTarget(platform, arch)).toBe(target);
    }
  });

  // Guards against someone re-introducing a divergent switch in a consumer, which is exactly
  // how #216 ended up with four tables that nothing forced to agree.
  test("the consumers read the table rather than their own copy", () => {
    for (const { platform, arch, target } of engineTargetEntries()) {
      expect(getEngineBinaryName(platform, arch)).toBe(target.assetName);
      expect(defaultBackendForPlatform(platform, arch)).toBe(target.backend);
    }
  });
});
