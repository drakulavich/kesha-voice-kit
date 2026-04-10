import { describe, test, expect } from "bun:test";
import {
  classifyCoreMLInstallProbe,
  createCoreMLBinaryRunner,
  ensureCoreMLModels,
  getCoreMLBinaryDownloadCandidates,
  getCoreMLDownloadURL,
  getCoreMLInstallState,
  getCoreMLInstallStatus,
  getCoreMLLatestDownloadURL,
  getCoreMLSupportDir,
  isUnreleasedVersion,
  parseCoreMLBinaryCapabilities,
  planCoreMLInstall,
  type CoreMLBinaryRunner,
} from "../../src/coreml-install";
import { join } from "path";
import { homedir } from "os";

describe("coreml-install", () => {
  test("getCoreMLSupportDir returns correct cache path", () => {
    expect(getCoreMLSupportDir()).toBe(
      join(homedir(), ".cache", "parakeet", "coreml"),
    );
  });

  test("getCoreMLDownloadURL includes version and correct filename", () => {
    const url = getCoreMLDownloadURL("0.5.0");
    expect(url).toBe(
      "https://github.com/drakulavich/parakeet-cli/releases/download/v0.5.0/parakeet-coreml-darwin-arm64",
    );
  });

  test("isUnreleasedVersion only enables latest fallback for dev versions", () => {
    expect(isUnreleasedVersion("0.8.0")).toBe(false);
    expect(isUnreleasedVersion("0.8.1-dev.1")).toBe(true);
    expect(isUnreleasedVersion("0.0.0")).toBe(true);
  });

  test("getCoreMLBinaryDownloadCandidates prefers package version for stable releases", () => {
    expect(getCoreMLBinaryDownloadCandidates("0.8.0")).toEqual([
      getCoreMLDownloadURL("0.8.0"),
    ]);
  });

  test("getCoreMLBinaryDownloadCandidates falls back to latest for unreleased versions", () => {
    expect(getCoreMLBinaryDownloadCandidates("0.8.1-dev.1")).toEqual([
      getCoreMLLatestDownloadURL(),
      getCoreMLDownloadURL("0.8.1-dev.1"),
    ]);
  });

  test("getCoreMLInstallState returns missing when binary is absent", () => {
    const state = getCoreMLInstallState({
      binPath: "/tmp/parakeet-coreml",
      exists: () => false,
    });

    expect(state).toBe("missing");
  });

  test("getCoreMLInstallState returns binary-only when readiness check fails", () => {
    const state = getCoreMLInstallState({
      binPath: "/tmp/parakeet-coreml",
      exists: () => true,
      verifyReady: () => "binary-only",
    });

    expect(state).toBe("binary-only");
  });

  test("getCoreMLInstallState returns ready when readiness check passes", () => {
    const state = getCoreMLInstallState({
      binPath: "/tmp/parakeet-coreml",
      exists: () => true,
      verifyReady: () => "ready",
    });

    expect(state).toBe("ready");
  });

  test("getCoreMLInstallState returns stale-binary when cached binary is too old", () => {
    const state = getCoreMLInstallState({
      binPath: "/tmp/parakeet-coreml",
      exists: () => true,
      verifyReady: () => "stale-binary",
    });

    expect(state).toBe("stale-binary");
  });

  test("getCoreMLInstallState defaults to binary-only when no readiness checker is provided", () => {
    const state = getCoreMLInstallState({
      binPath: "/tmp/parakeet-coreml",
      exists: () => true,
    });

    expect(state).toBe("binary-only");
  });

  test("planCoreMLInstall skips work when install is ready", () => {
    expect(planCoreMLInstall("ready")).toEqual({
      downloadBinary: false,
      downloadModels: false,
    });
  });

  test("planCoreMLInstall downloads only models when binary already exists", () => {
    expect(planCoreMLInstall("binary-only")).toEqual({
      downloadBinary: false,
      downloadModels: true,
    });
  });

  test("planCoreMLInstall forces both downloads with no-cache", () => {
    expect(planCoreMLInstall("ready", true)).toEqual({
      downloadBinary: true,
      downloadModels: true,
    });
  });

  test("planCoreMLInstall refreshes stale cached binaries", () => {
    expect(planCoreMLInstall("stale-binary")).toEqual({
      downloadBinary: true,
      downloadModels: true,
    });
  });

  test("parseCoreMLBinaryCapabilities accepts the current protocol payload", () => {
    expect(
      parseCoreMLBinaryCapabilities(
        JSON.stringify({
          protocolVersion: 1,
          installState: "ready",
          supportedCommands: {
            checkInstall: true,
            downloadOnly: true,
          },
        }),
      ),
    ).toEqual({
      protocolVersion: 1,
      installState: "ready",
      supportedCommands: {
        checkInstall: true,
        downloadOnly: true,
      },
    });
  });

  test("parseCoreMLBinaryCapabilities rejects malformed payloads", () => {
    expect(
      parseCoreMLBinaryCapabilities("{invalid"),
    ).toBeNull();
    expect(
      parseCoreMLBinaryCapabilities(
        JSON.stringify({
          protocolVersion: 2,
          installState: "ready",
          supportedCommands: {
            checkInstall: true,
            downloadOnly: true,
          },
        }),
      ),
    ).toBeNull();
  });

  test("classifyCoreMLInstallProbe classifies capabilities responses", () => {
    expect(
      classifyCoreMLInstallProbe(1, ""),
    ).toBe("stale-binary");
    expect(
      classifyCoreMLInstallProbe(
        0,
        JSON.stringify({
          protocolVersion: 1,
          installState: "models-missing",
          supportedCommands: {
            checkInstall: true,
            downloadOnly: true,
          },
        }),
      ),
    ).toBe("binary-only");
    expect(
      classifyCoreMLInstallProbe(
        0,
        JSON.stringify({
          protocolVersion: 1,
          installState: "ready",
          supportedCommands: {
            checkInstall: true,
            downloadOnly: true,
          },
        }),
      ),
    ).toBe("ready");
    expect(
      classifyCoreMLInstallProbe(0, "{\"protocolVersion\":999}"),
    ).toBe("stale-binary");
  });

  test("createCoreMLBinaryRunner runs the expected commands", () => {
    const calls: string[][] = [];
    const runner = createCoreMLBinaryRunner((cmd) => {
      calls.push(Array.isArray(cmd) ? cmd : cmd.cmd);
      return {
        exitCode: 0,
        stdout: Buffer.from("{}"),
        stderr: Buffer.from(""),
      } as ReturnType<typeof Bun.spawnSync>;
    });

    runner.probeCapabilities("/tmp/parakeet-coreml");
    runner.downloadModels("/tmp/parakeet-coreml");

    expect(calls).toEqual([
      ["/tmp/parakeet-coreml", "--capabilities-json"],
      ["/tmp/parakeet-coreml", "--download-only"],
    ]);
  });

  test("getCoreMLInstallStatus delegates to the runner probe", () => {
    const runner: CoreMLBinaryRunner = {
      probeCapabilities() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            protocolVersion: 1,
            installState: "models-missing",
            supportedCommands: {
              checkInstall: true,
              downloadOnly: true,
            },
          }),
          stderr: "",
        };
      },
      downloadModels() {
        throw new Error("not used");
      },
    };

    expect(getCoreMLInstallStatus("/tmp/parakeet-coreml", runner)).toBe("binary-only");
  });

  test("ensureCoreMLModels streams command output through the writer", async () => {
    const writes = {
      stdout: [] as string[],
      stderr: [] as string[],
    };
    const runner: CoreMLBinaryRunner = {
      probeCapabilities() {
        throw new Error("not used");
      },
      downloadModels() {
        return {
          exitCode: 0,
          stdout: "downloaded\n",
          stderr: "progress\n",
        };
      },
    };

    await ensureCoreMLModels("/tmp/parakeet-coreml", runner, {
      stdout(message) {
        writes.stdout.push(message);
      },
      stderr(message) {
        writes.stderr.push(message);
      },
    });

    expect(writes).toEqual({
      stdout: ["downloaded\n"],
      stderr: ["progress\n"],
    });
  });

  test("ensureCoreMLModels throws a contextual error when download fails", async () => {
    const runner: CoreMLBinaryRunner = {
      probeCapabilities() {
        throw new Error("not used");
      },
      downloadModels() {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "download failed",
        };
      },
    };

    await expect(
      ensureCoreMLModels("/tmp/parakeet-coreml", runner, {
        stdout() {},
        stderr() {},
      }),
    ).rejects.toThrow("Failed to download CoreML models: download failed");
  });
});
