import { describe, test, expect } from "bun:test";
import {
  classifyCoreMLInstallProbe,
  getCoreMLDownloadURL,
  getCoreMLInstallState,
  getCoreMLSupportDir,
  parseCoreMLBinaryCapabilities,
  planCoreMLInstall,
} from "../coreml-install";
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
});
