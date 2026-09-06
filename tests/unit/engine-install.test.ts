import { describe, test, expect, spyOn } from "bun:test";
import {
  buildEngineInstallArgs,
  cleanupRetiredSidecars,
  getVersionMarkerPath,
  getEngineBinaryName,
  isTransientSpawnLock,
  waitUntilSpawnable,
  readInstalledEngineVersion,
  writeInstalledEngineVersion,
  validateInstallRequest,
  runEngineModelInstall,
} from "../../src/engine-install";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { defaultEngineBinPath } from "../../src/paths";
import { KeshaError } from "../../src/engine/events";
import { log } from "../../src/log";
import { describeJson, saveEngineEnv, stageEngineHome, writeFakeEngine } from "../helpers/fake-engine";

/** The thrown KeshaError, so a test can assert on code and hint rather than on prose. */
async function failure(run: () => Promise<unknown>): Promise<KeshaError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof KeshaError) return err;
    throw err;
  }
  throw new Error("expected a KeshaError");
}

/** A describe-only stub reporting a specific backend, for cases writeFakeEngine's hardcoded "fake-coreml" can't cover. */
function writeFakeEngineWithBackend(binDir: string, backend: string, features: string[]): string {
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "kesha-engine");
  const doc = describeJson({ backend, features });
  writeFileSync(
    binPath,
    `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${doc}'\n  exit 0\nfi\nexit 2\n`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

function mkTmpBinPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "kesha-install-test-"));
  return join(dir, "kesha-engine");
}

describe("engine-install version marker (#151)", () => {
  test("getVersionMarkerPath appends .version alongside binary", () => {
    expect(getVersionMarkerPath("/bin/kesha-engine")).toBe("/bin/kesha-engine.version");
    expect(getVersionMarkerPath("/tmp/foo/x")).toBe("/tmp/foo/x.version");
  });

  test("reads back what was written", () => {
    const binPath = mkTmpBinPath();
    writeInstalledEngineVersion(binPath, "1.2.0");
    expect(readInstalledEngineVersion(binPath)).toBe("1.2.0");
    rmSync(binPath + ".version");
  });

  test("returns null when marker missing", () => {
    const binPath = mkTmpBinPath();
    expect(readInstalledEngineVersion(binPath)).toBeNull();
  });

  test("returns null for empty marker (corrupted file treated as missing)", () => {
    const binPath = mkTmpBinPath();
    writeFileSync(binPath + ".version", "");
    expect(readInstalledEngineVersion(binPath)).toBeNull();
    rmSync(binPath + ".version");
  });

  test("returns null for whitespace-only marker", () => {
    const binPath = mkTmpBinPath();
    writeFileSync(binPath + ".version", "  \n  ");
    expect(readInstalledEngineVersion(binPath)).toBeNull();
    rmSync(binPath + ".version");
  });

  test("trims surrounding whitespace on read (hand-written marker)", () => {
    // Test via writeFileSync so the trim path is actually exercised —
    // writeInstalledEngineVersion only appends one \n, which String.trim
    // would strip regardless of our handling.
    const binPath = mkTmpBinPath();
    writeFileSync(binPath + ".version", "  1.2.0\n\n\n");
    expect(readInstalledEngineVersion(binPath)).toBe("1.2.0");
    rmSync(binPath + ".version");
  });

  test("overwrite replaces previous version", () => {
    const binPath = mkTmpBinPath();
    writeInstalledEngineVersion(binPath, "1.1.3");
    writeInstalledEngineVersion(binPath, "1.2.0");
    expect(readInstalledEngineVersion(binPath)).toBe("1.2.0");
    rmSync(binPath + ".version");
  });
});

describe("buildEngineInstallArgs (#517)", () => {
  test("tts languages become positional args after --tts", () => {
    expect(buildEngineInstallArgs({ noCache: false, ttsLangs: ["en", "ru"] }))
      .toEqual(["install", "--tts", "en", "ru"]);
  });
  test("no tts langs omits --tts", () => {
    expect(buildEngineInstallArgs({ noCache: true, ttsLangs: [] }))
      .toEqual(["install", "--no-cache"]);
  });
  test("--diarize pulls in --vad, which speaker labels depend on (#768)", () => {
    expect(buildEngineInstallArgs({ noCache: false, diarize: true }))
      .toEqual(["install", "--vad", "--diarize"]);
    expect(buildEngineInstallArgs({ noCache: false, vad: true, diarize: true }))
      .toEqual(["install", "--vad", "--diarize"]);
    expect(buildEngineInstallArgs({ noCache: false, vad: true })).toEqual(["install", "--vad"]);
  });
});

const installGateTest = process.platform === "win32" ? test.skip : test;

describe("validateInstallRequest gates on the describe document", () => {
  installGateTest("--diarize against a build without it is E_INVALID_ARG carrying the Nix hint", async () => {
    const restore = saveEngineEnv();
    const home = stageEngineHome("kesha-install-gate-diarize-");
    try {
      writeFakeEngine(home.binDir, ["tts"]);
      const err = await failure(() => validateInstallRequest({ noCache: false, diarize: true }));
      expect(err.code).toBe("E_INVALID_ARG");
      expect(err.hint).toContain("bun add -g @drakulavich/kesha-voice-kit");
      expect(err.message).toContain("--diarize");
    } finally {
      restore();
      rmSync(home.dir, { recursive: true, force: true });
    }
  });

  installGateTest("a backend the installed engine does not have is refused before any download", async () => {
    const restore = saveEngineEnv();
    const home = stageEngineHome("kesha-install-gate-backend-");
    try {
      writeFakeEngineWithBackend(home.binDir, "onnx", ["tts"]);
      const err = await failure(() => validateInstallRequest({ noCache: false, backend: "coreml" }));
      expect(err.code).toBe("E_INVALID_ARG");
      expect(err.message).toContain("onnx");
    } finally {
      restore();
      rmSync(home.dir, { recursive: true, force: true });
    }
  });

  installGateTest("a supported request returns the argv the engine will run", async () => {
    const restore = saveEngineEnv();
    const home = stageEngineHome("kesha-install-gate-argv-");
    try {
      writeFakeEngine(home.binDir, ["tts"]);
      const argv = await validateInstallRequest({ noCache: true, ttsLangs: ["en"] });
      expect(argv).toEqual(["install", "--no-cache", "--tts", "en"]);
    } finally {
      restore();
      rmSync(home.dir, { recursive: true, force: true });
    }
  });
});

describe("engine-install retired sidecar cleanup (#438)", () => {
  test("removes old Kokoro and diarize helpers without touching active helpers", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-retired-sidecar-test-"));
    const engineDir = join(dir, "engine", "bin");

    try {
      mkdirSync(engineDir, { recursive: true });
      for (const filename of [
        "kesha-kokoro",
        "kesha-kokoro-darwin-arm64",
        "kesha-diarize",
        "kesha-diarize-darwin-arm64",
        "say-avspeech",
        "say-avspeech-darwin-arm64",
        "kesha-textlang",
        "kesha-textlang-darwin-arm64",
        "kesha-engine",
      ]) {
        writeFileSync(join(engineDir, filename), "binary");
      }

      const removed = cleanupRetiredSidecars(engineDir).sort();

      expect(removed).toEqual([
        "kesha-diarize",
        "kesha-diarize-darwin-arm64",
        "kesha-kokoro",
        "kesha-kokoro-darwin-arm64",
      ]);
      for (const filename of removed) {
        expect(existsSync(join(engineDir, filename))).toBe(false);
      }
      for (const filename of [
        "say-avspeech",
        "say-avspeech-darwin-arm64",
        "kesha-textlang",
        "kesha-textlang-darwin-arm64",
        "kesha-engine",
      ]) {
        expect(existsSync(join(engineDir, filename))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op when retired helpers are absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-retired-sidecar-empty-test-"));

    try {
      expect(cleanupRetiredSidecars(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getEngineBinaryName platform mapping (#216)", () => {
  test("win32-x64 returns the published Windows asset", () => {
    expect(getEngineBinaryName("win32", "x64")).toBe("kesha-engine-windows-x64.exe");
  });
  test("darwin-arm64 and linux-x64 are unchanged", () => {
    expect(getEngineBinaryName("darwin", "arm64")).toBe("kesha-engine-darwin-arm64");
    expect(getEngineBinaryName("linux", "x64")).toBe("kesha-engine-linux-x64");
  });
  test("platforms without a published engine still throw", () => {
    expect(() => getEngineBinaryName("win32", "arm64")).toThrow(/Unsupported platform/);
    expect(() => getEngineBinaryName("darwin", "x64")).toThrow(/Unsupported platform/);
    expect(() => getEngineBinaryName("linux", "arm64")).toThrow(/Unsupported platform/);
  });
});

describe("defaultEngineBinPath extension (#216)", () => {
  test("win32 keeps the .exe suffix so the downloaded PE is spawnable", () => {
    expect(defaultEngineBinPath("win32")).toEndWith("kesha-engine.exe");
  });
  test("posix platforms stay extensionless", () => {
    expect(defaultEngineBinPath("linux")).toEndWith("kesha-engine");
    expect(defaultEngineBinPath("darwin")).toEndWith("kesha-engine");
  });
  test("the version marker follows the binary name on win32", () => {
    expect(getVersionMarkerPath(defaultEngineBinPath("win32"))).toMatch(
      /kesha-engine\.exe\.version$/,
    );
  });
});

describe("waitUntilSpawnable (#216)", () => {
  test("classifies lock errors as transient, everything else as fatal", () => {
    expect(isTransientSpawnLock("EBUSY: resource busy or locked, uv_spawn")).toBe(true);
    expect(isTransientSpawnLock("ETXTBSY: text file is busy, uv_spawn")).toBe(true);
    expect(isTransientSpawnLock("ENOENT: no such file or directory")).toBe(false);
    expect(isTransientSpawnLock("ENOEXEC: exec format error")).toBe(false);
    // Policy, not a scanner: waiting these out would stall an install that can never succeed.
    expect(isTransientSpawnLock("EACCES: permission denied")).toBe(false);
    expect(isTransientSpawnLock("EPERM: operation not permitted")).toBe(false);
  });

  // The fixture is a shell script, which Windows cannot spawn — the lock-clearing
  // behaviour itself is what `windows-engine-smoke` exercises against a real PE.
  const spawnFixtureTest = process.platform === "win32" ? test.skip : test;

  spawnFixtureTest("returns once the binary spawns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-spawnable-"));
    try {
      const binPath = join(dir, "engine");
      writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
      chmodSync(binPath, 0o755);
      await waitUntilSpawnable(binPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Gatekeeper SIGKILLs an untrusted ad-hoc binary after the spawn succeeds, so "it spawned"
  // was never proof it ran — and the `.version` marker written next vouched for it (#770).
  spawnFixtureTest("a binary killed by a signal is not accepted as spawnable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-spawnable-killed-"));
    try {
      const binPath = join(dir, "engine");
      writeFileSync(binPath, "#!/bin/sh\nkill -9 $$\n");
      chmodSync(binPath, 0o755);
      await expect(waitUntilSpawnable(binPath, 1_000)).rejects.toThrow(/could not be started/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A missing binary never becomes spawnable, so retrying it would just stall the
  // install for the full deadline before failing anyway.
  test("fails fast on a non-transient error instead of waiting out the deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-spawnable-missing-"));
    try {
      const startedAt = Date.now();
      await expect(
        waitUntilSpawnable(join(dir, "does-not-exist"), 60_000),
      ).rejects.toThrow(/could not be started/);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runEngineModelInstall speaks protocol 4 (#1163)", () => {
  const posixTest = process.platform === "win32" ? test.skip : test;

  function writeInstallEngine(dir: string, body: string): string {
    const binPath = join(dir, "kesha-engine");
    writeFileSync(binPath, `#!/bin/sh\n${body}\n`);
    chmodSync(binPath, 0o755);
    return binPath;
  }

  posixTest("an engine error event fails the run as a coded KeshaError, not a plain Error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-v4-error-"));
    const binPath = writeInstallEngine(
      dir,
      `printf '%s\\n' '{"kind":"error","code":"E_MODEL_MISSING","message":"manifest hash mismatch"}' >&2\nexit 1`,
    );
    try {
      const err = await runEngineModelInstall(binPath, ["install"]).then(
        () => null,
        (e: unknown) => e as KeshaError,
      );
      expect(err).toBeInstanceOf(KeshaError);
      expect(err!.code).toBe("E_MODEL_MISSING");
      expect(err!.message).toBe("manifest hash mismatch");
      expect(err!.origin).toBe("engine");
      expect(err!.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * #680: a piped child read only at exit looks hung on a multi-GB download. The stub
   * blocks after its first progress event until the caller's sink has actually seen it
   * (by writing an ack file), so a buffered (non-live) implementation would time out
   * here instead of the fallback message arriving with the wrong text.
   */
  posixTest("progress events reach the caller live and in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-install-v4-progress-"));
    const ack = join(dir, "ack");
    const binPath = writeInstallEngine(
      dir,
      `printf '%s\\n' '{"kind":"progress","message":"GET model-a.bin"}' >&2
i=0
while [ ! -e '${ack}' ] && [ "$i" -lt 100 ]; do
  sleep 0.05
  i=$((i + 1))
done
if [ -e '${ack}' ]; then
  printf '%s\\n' '{"kind":"progress","message":"OK model-a.bin"}' >&2
else
  printf '%s\\n' '{"kind":"progress","message":"TIMED OUT WAITING FOR ACK"}' >&2
fi
exit 0`,
    );
    const seen: string[] = [];
    const progressSpy = spyOn(log, "progress").mockImplementation((msg: string) => {
      seen.push(msg);
      if (msg === "GET model-a.bin") writeFileSync(ack, "");
    });
    try {
      await runEngineModelInstall(binPath, ["install"]);
    } finally {
      progressSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(seen).toEqual(["Installing models...", "GET model-a.bin", "OK model-a.bin"]);
  });
});
