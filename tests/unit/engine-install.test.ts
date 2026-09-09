import { afterEach, describe, test, expect } from "bun:test";
import {
  buildEngineInstallArgs,
  cleanupRetiredSidecars,
  getVersionMarkerPath,
  getEngineBinaryName,
  isTransientSpawnLock,
  waitUntilSpawnable,
  readInstalledEngineVersion,
  writeInstalledEngineVersion,
  installEngine,
  SIDECARS,
} from "../../src/engine-install";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { defaultEngineBinPath } from "../../src/paths";
import { engineVersion } from "../../src/package-info";
import { isDarwinArm64 } from "../../src/engine-targets";
import { KeshaError } from "../../src/engine/events";
import { describeJson, isolateEngineCache } from "../helpers/fake-engine";
import { tempDir } from "../helpers/temp-dir";

/** Strips ANSI SGR sequences so captured `process.stderr.write` output can be asserted on plainly. */
function stripAnsi(text: string): string {
  return text.replace(/\[[0-9;]*m/g, "");
}

function mkTmpBinPath(): string {
  const dir = tempDir("kesha-install-test-");
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

describe("the install spawns speak protocol 4 (#1163, #1181)", () => {
  // The warmup only ever spawns on darwin-arm64 — same gate `engine-install-decisions.test.ts` uses.
  const darwinArmTest = isDarwinArm64() ? test : test.skip;
  // The stubs below are `#!/bin/sh`; Windows cannot execute one, and these assert no Windows behaviour.
  const posixTest = process.platform === "win32" ? test.skip : test;
  let releaseCacheIsolation: () => void = () => {};
  const tempDirs: string[] = [];

  afterEach(() => {
    releaseCacheIsolation();
    releaseCacheIsolation = () => {};
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A cache-valid engine dir, staged the same way as the model-install suite above. */
  function stageInstallableEngine(prefix: string): string {
    releaseCacheIsolation = isolateEngineCache();
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    mkdirSync(join(dir, "bin"), { recursive: true });
    for (const spec of SIDECARS) {
      const path = join(dir, "bin", spec.fileBasename);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }
    return dir;
  }

  /** Answers `describe`, `--version` and `install` for the cache-validity/model-install phases, and `say` (the warmup) with `sayBody`. */
  function writeEngineWithSayBody(dir: string, sayBody: string): string {
    const binPath = join(dir, "bin", "kesha-engine");
    writeFileSync(
      binPath,
      `#!/bin/sh
case "$1" in
  describe) printf '%s\\n' '${describeJson({ features: ["tts"] })}'; exit 0 ;;
  --version) printf 'kesha-engine ${engineVersion}\\n'; exit 0 ;;
  install) exit 0 ;;
esac
if [ "$1" = "say" ]; then
${sayBody}
fi
exit 0
`,
    );
    chmodSync(binPath, 0o755);
    writeFileSync(`${binPath}.version`, `${engineVersion}\n`);
    process.env.KESHA_ENGINE_BIN = binPath;
    return binPath;
  }

  /** Captures stderr for the duration of `run`, ANSI stripped, with `isTTY` forced so redirection is the test's choice. */
  async function captureStderr(isTTY: boolean, run: () => Promise<void>): Promise<string> {
    const savedIsTTY = process.stderr.isTTY;
    const savedWrite = process.stderr.write;
    Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
    const chunks: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await run();
    } finally {
      process.stderr.write = savedWrite;
      Object.defineProperty(process.stderr, "isTTY", { value: savedIsTTY, configurable: true });
    }
    return stripAnsi(chunks.join(""));
  }

  /** Answers `describe`, `--version` and `install`, with `installBody` driving the model-install spawn. */
  function writeEngineWithInstallBody(dir: string, installBody: string, installExit = 0): string {
    const binPath = join(dir, "bin", "kesha-engine");
    writeFileSync(
      binPath,
      `#!/bin/sh
case "\$1" in
  describe) printf '%s\\n' '${describeJson({ features: ["tts"] })}'; exit 0 ;;
  --version) printf 'kesha-engine ${engineVersion}\\n'; exit 0 ;;
esac
if [ "\$1" = "install" ]; then
${installBody}
  exit ${installExit}
fi
exit 0
`,
    );
    chmodSync(binPath, 0o755);
    writeFileSync(`${binPath}.version`, `${engineVersion}\n`);
    process.env.KESHA_ENGINE_BIN = binPath;
    return binPath;
  }

  /**
   * The engine painted the byte bar itself until protocol 4 (#1181) and never painted it when
   * stderr was redirected. A line per whole percent would add hundreds of rows to every CI
   * install log, so the percentage belongs on the repainting row and nowhere else.
   */
  posixTest("a redirected install keeps its discrete steps and gains no line per percent", async () => {
    const dir = stageInstallableEngine("kesha-install-progress-");
    writeEngineWithInstallBody(
      dir,
      `  printf '%s\\n' '{"kind":"progress","message":"GET models/encoder.onnx"}' >&2
  printf '%s\\n' '{"kind":"progress","phase":"download","message":"models/encoder.onnx 1.0/2.0MB","pct":50}' >&2
  printf '%s\\n' '{"kind":"progress","phase":"download","message":"models/encoder.onnx 2.0/2.0MB","pct":100}' >&2
  printf '%s\\n' '{"kind":"progress","message":"OK  models/encoder.onnx"}' >&2`,
    );

    const stderr = await captureStderr(false, async () => {
      await installEngine({});
    });

    expect(stderr).toContain("GET models/encoder.onnx");
    expect(stderr).toContain("OK  models/encoder.onnx");
    expect(stderr).not.toContain("1.0/2.0MB");
    expect(stderr).not.toContain("2.0/2.0MB");
  });

  posixTest("on a terminal the byte counter repaints one row and the discrete steps keep their lines", async () => {
    const dir = stageInstallableEngine("kesha-install-progress-tty-");
    writeEngineWithInstallBody(
      dir,
      `  printf '%s\\n' '{"kind":"progress","message":"GET models/encoder.onnx"}' >&2
  printf '%s\\n' '{"kind":"progress","phase":"download","message":"models/encoder.onnx 1.0/2.0MB","pct":50}' >&2
  printf '%s\\n' '{"kind":"progress","phase":"download","message":"models/encoder.onnx 2.0/2.0MB","pct":100}' >&2`,
    );

    const stderr = await captureStderr(true, async () => {
      await installEngine({});
    });

    expect(stderr).toContain("\rdownload: models/encoder.onnx 1.0/2.0MB");
    expect(stderr).toContain("\rdownload: models/encoder.onnx 2.0/2.0MB");
    expect(stderr).not.toContain("models/encoder.onnx 1.0/2.0MB\n");
    expect(stderr).toContain("GET models/encoder.onnx\n");
  });

  posixTest("a failing model install raises the engine's code, not a bare exit status", async () => {
    const dir = stageInstallableEngine("kesha-install-coded-");
    writeEngineWithInstallBody(
      dir,
      `  printf '%s\\n' '{"kind":"error","code":"E_DOWNLOAD_FAILED","message":"models/encoder.onnx: connection reset","hint":"retry"}' >&2`,
      1,
    );

    let caught: unknown;
    try {
      await installEngine({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KeshaError);
    expect((caught as KeshaError).code).toBe("E_DOWNLOAD_FAILED");
    expect((caught as KeshaError).hint).toBe("retry");
  });

  darwinArmTest("a say error event warns with the rendered coded line, and the install still resolves", async () => {
    const dir = stageInstallableEngine("kesha-warmup-error-");
    writeEngineWithSayBody(
      dir,
      `printf '%s\\n' '{"kind":"error","code":"E_MODEL_MISSING","message":"kokoro weights missing"}' >&2
exit 1`,
    );

    const stderr = await captureStderr(false, async () => {
      await installEngine({ ttsLangs: ["en"] });
    });

    expect(stderr).toContain("error [E_MODEL_MISSING]: kokoro weights missing");
  });

  // Fake timers destabilise the install pipeline's other real subprocess phases, so this covers the sibling warn-and-resolve path via a signal kill instead of the real 180s deadline.
  darwinArmTest("a say child killed by a signal still warns generically, and the install still resolves", async () => {
    const dir = stageInstallableEngine("kesha-warmup-killed-");
    writeEngineWithSayBody(dir, "kill -TERM $$\nsleep 5");

    const stderr = await captureStderr(false, async () => {
      await installEngine({ ttsLangs: ["en"] });
    });

    expect(stderr).toContain("FluidAudio Kokoro warmup failed");
    expect(stderr).toContain("first `kesha say en-*` may still be slow");
  });
});
