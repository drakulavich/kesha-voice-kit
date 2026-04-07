import { describe, test, expect } from "bun:test";
import { getCoreMLBinPath, isMacArm64, isCoreMLInstalled } from "../coreml";
import { join } from "path";
import { homedir } from "os";

describe("coreml", () => {
  test("getCoreMLBinPath returns correct cache path", () => {
    const binPath = getCoreMLBinPath();
    expect(binPath).toBe(
      join(homedir(), ".cache", "parakeet", "coreml", "bin", "parakeet-coreml"),
    );
  });

  test("isMacArm64 returns a boolean", () => {
    const result = isMacArm64();
    expect(typeof result).toBe("boolean");
    if (process.platform === "darwin" && process.arch === "arm64") {
      expect(result).toBe(true);
    } else {
      expect(result).toBe(false);
    }
  });

  test("isCoreMLInstalled returns a boolean", () => {
    const result = isCoreMLInstalled();
    expect(typeof result).toBe("boolean");
  });
});
