import { describe, test, expect } from "bun:test";
import {
  getCoreMLBinPath,
  isMacArm64,
  isCoreMLInstalled,
  shouldRetryCoreMLWithWav,
} from "../coreml";
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

  test("retries non-wav files on CoreAudio decode errors", () => {
    expect(
      shouldRetryCoreMLWithWav(
        "fixtures/hello-english.oga",
        new Error("Error: The operation couldn’t be completed. (com.apple.coreaudio.avfaudio error 1718449215.)"),
      ),
    ).toBe(true);
  });

  test("does not retry wav files on CoreAudio decode errors", () => {
    expect(
      shouldRetryCoreMLWithWav(
        "fixtures/silence.wav",
        new Error("Error: The operation couldn’t be completed. (com.apple.coreaudio.avfaudio error 1718449215.)"),
      ),
    ).toBe(false);
  });
});
