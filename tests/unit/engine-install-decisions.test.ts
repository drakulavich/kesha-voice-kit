import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { homedir, tmpdir } from "os";
import {
  assertNotRealCacheUnderTest,
  getEngineBinaryName,
  installEngine,
  SIDECARS,
} from "../../src/engine-install";
import { isDarwinArm64 } from "../../src/fluid-kokoro-cache";
import { engineVersion } from "../../src/package-info";
import { isolateEngineCache } from "../helpers/fake-engine";

const DIARIZE_CAPS = {
  protocolVersion: 3,
  backend: "coreml",
  features: ["tts", "transcribe.diarize"],
};
const PLAIN_CAPS = { protocolVersion: 3, backend: "onnx", features: ["tts"] };

interface EngineStub {
  caps?: Record<string, unknown> | null;
  installExit?: number;
  sayExit?: number;
}

/** POSIX single-quote escape, so a quote in the JSON or the path cannot end the sh literal. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A shell stub answering the three things `installEngine` asks of a real engine:
 * `--capabilities-json`, `install`, and `say` (the Kokoro warmup). Each invocation appends
 * its argv to `argvLog`, so a test can state what the engine was asked to do.
 *
 * The log path is baked into the script rather than read from the environment: Bun.spawn
 * snapshots the environment at process start, so a `process.env` key set inside a test never
 * reaches the child.
 */
function engineScript({ caps = PLAIN_CAPS, installExit = 0, sayExit = 0 }: EngineStub = {}): string {
  const capsCase = caps
    ? `  --capabilities-json) printf '%s\\n' ${shQuote(JSON.stringify(caps))}; exit 0 ;;\n`
    : `  --capabilities-json) exit 2 ;;\n`;
  return (
    `#!/bin/sh\n` +
    `echo "$*" >> ${shQuote(argvLog)}\n` +
    `case "$1" in\n` +
    capsCase +
    `  install) exit ${installExit} ;;\n` +
    `  say) exit ${sayExit} ;;\n` +
    `esac\n` +
    `exit 0\n`
  );
}

const savedFetch = globalThis.fetch;
const tempDirs: string[] = [];
let releaseCacheIsolation: () => void = () => {};
let argvLog = "";

const posixTest = process.platform === "win32" ? test.skip : test;
/** The Kokoro warmup and the sidecars only ever run on darwin-arm64. */
const darwinArmTest = isDarwinArm64() ? test : test.skip;

beforeEach(() => {
  releaseCacheIsolation = isolateEngineCache();
  const dir = mkdtempSync(join(tmpdir(), "kesha-argv-log-"));
  tempDirs.push(dir);
  argvLog = join(dir, "argv.log");
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  releaseCacheIsolation();
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(join(dir, "bin"), 0o755);
    } catch {
      // only the read-only case created that directory
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Every argv the engine stub was invoked with, in order. */
function engineInvocations(): string[] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8").split("\n").filter(Boolean);
}

/** Stages a cache-valid install: right version, runnable engine, healthy sidecars. */
function stageInstalledEngine(prefix: string, stub: EngineStub = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  const binPath = join(dir, "bin", "kesha-engine");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(binPath, engineScript(stub));
  chmodSync(binPath, 0o755);
  writeFileSync(`${binPath}.version`, `${engineVersion}\n`);
  // A sidecar that cannot run is re-downloaded on every cache hit (#770), which would
  // drag an unrelated fetch into these tests.
  for (const spec of SIDECARS) {
    const path = join(dir, "bin", spec.fileBasename);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

/** Points KESHA_ENGINE_BIN at an empty dir so the install has to download. */
function stageEmptyEngineDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  const binPath = join(dir, "bin", "kesha-engine");
  mkdirSync(join(dir, "bin"), { recursive: true });
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

/** Serves a working engine for every release asset, recording the URLs asked for. */
function stubRelease(stub: EngineStub = {}): string[] {
  const urls: string[] = [];
  const body = engineScript(stub);
  globalThis.fetch = (async (input: Request | URL | string) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
  }) as typeof fetch;
  return urls;
}

function engineDownloads(urls: string[]): string[] {
  const binaryName = getEngineBinaryName();
  return urls.filter((u) => u.endsWith(binaryName));
}

const realEngineBin = join(homedir(), ".cache", "kesha", "engine", "bin", "kesha-engine");

// The developer's real ~/.cache/kesha was overwritten with a test stub because pointing
// KESHA_ENGINE_BIN at a temp path is opt-in per test, and the fallback is the real cache.
describe("an install only ever writes where it was pointed (#796)", () => {
  posixTest("with no KESHA_ENGINE_BIN it installs under KESHA_CACHE_DIR", async () => {
    delete process.env.KESHA_ENGINE_BIN;
    const cacheDir = process.env.KESHA_CACHE_DIR!;
    // Also the cold-install case: nothing under the cache dir exists yet, so the install
    // has to create the engine dir rather than refuse it as unwritable.
    expect(existsSync(join(cacheDir, "engine"))).toBe(false);
    stubRelease();

    await installEngine();

    expect(readFileSync(join(cacheDir, "engine", "bin", "kesha-engine"), "utf8")).toContain(
      "#!/bin/sh",
    );
  }, 30_000);

  // The adversarial half: isolation is opt-in, so prove that forgetting it fails loudly
  // rather than reaching ~/.cache/kesha. Asserted on the predicate, never by running an
  // install at the real path — under mutation a disabled guard would do exactly the damage
  // this test exists to rule out.
  posixTest("a test that forgets to isolate is refused, not silently served", () => {
    expect(() => assertNotRealCacheUnderTest(realEngineBin)).toThrow(/real\s+per-user cache/);
  });

  posixTest("the guard leaves a redirected cache alone", () => {
    expect(() =>
      assertNotRealCacheUnderTest(join(process.env.KESHA_CACHE_DIR!, "engine", "bin", "kesha-engine")),
    ).not.toThrow();
  });

  // The guard must not cost a real user their install: outside `bun test` it is inert, even
  // for the very path it refuses under one.
  posixTest("outside a test run the real cache is allowed", () => {
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(() => assertNotRealCacheUnderTest(realEngineBin)).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  });
});

describe("capabilities gate the flags forwarded to the engine (#772)", () => {
  posixTest("a backend the installed engine does not provide fails by name", async () => {
    const binPath = stageInstalledEngine("kesha-caps-backend-mismatch-");
    const before = readFileSync(binPath, "utf8");
    stubRelease();

    await expect(installEngine({ backend: "coreml" })).rejects.toThrow(/coreml.*onnx|onnx.*coreml/s);

    expect(readFileSync(binPath, "utf8")).toBe(before);
  }, 30_000);

  posixTest("the backend the engine reports is accepted", async () => {
    const binPath = stageInstalledEngine("kesha-caps-backend-match-");
    stubRelease();

    expect(await installEngine({ backend: "onnx" })).toBe(binPath);
  }, 30_000);

  posixTest("--diarize on an engine built without it names the missing feature", async () => {
    const binPath = stageInstalledEngine("kesha-caps-no-diarize-");
    const before = readFileSync(binPath, "utf8");
    stubRelease();

    await expect(installEngine({ diarize: true })).rejects.toThrow(/system_diarize/);

    expect(readFileSync(binPath, "utf8")).toBe(before);
  }, 30_000);

  // A pre-capabilities engine cannot be asked, and forwarding --diarize blind would surface
  // as clap's generic "unexpected argument". Reached through a download because a cached
  // engine that describes nothing is repaired before any flag is validated (#801).
  posixTest("--diarize is refused when the engine cannot describe itself", async () => {
    stageEmptyEngineDir("kesha-caps-silent-");
    stubRelease({ caps: null });

    await expect(installEngine({ diarize: true })).rejects.toThrow(/system_diarize/);
  }, 30_000);

  posixTest("a cached engine that describes nothing is repaired before the flag is judged", async () => {
    const binPath = stageInstalledEngine("kesha-caps-mute-cache-", { caps: null });
    const urls = stubRelease();

    await expect(installEngine({ diarize: true })).rejects.toThrow(/system_diarize/);

    expect(engineDownloads(urls)).toHaveLength(1);
    expect(readFileSync(binPath, "utf8")).toContain("--capabilities-json");
  }, 30_000);

  posixTest("--diarize reaches the engine, and pulls --vad with it (#768)", async () => {
    stageInstalledEngine("kesha-caps-diarize-", { caps: DIARIZE_CAPS });
    stubRelease();

    await installEngine({ diarize: true });

    const install = engineInvocations().find((a) => a.startsWith("install"));
    expect(install).toContain("--diarize");
    expect(install).toContain("--vad");
  }, 30_000);
});

describe("a failing model install is not reported as success", () => {
  posixTest("the engine's exit code reaches the caller", async () => {
    stageInstalledEngine("kesha-model-install-fails-", { installExit: 42 });
    stubRelease();

    await expect(installEngine()).rejects.toThrow(/42/);
  }, 30_000);
});

describe("cache validity (#775)", () => {
  posixTest("--no-cache re-downloads an engine the marker vouches for", async () => {
    stageInstalledEngine("kesha-nocache-writable-");
    const urls = stubRelease();

    await installEngine({ noCache: true });

    expect(engineDownloads(urls)).toHaveLength(1);
  }, 30_000);

  posixTest("without --no-cache the same install downloads nothing", async () => {
    stageInstalledEngine("kesha-nocache-off-");
    const urls = stubRelease();

    await installEngine();

    expect(engineDownloads(urls)).toHaveLength(0);
  }, 30_000);

  // On a read-only engine dir --no-cache cannot re-download, and turning that into a hard
  // error would break the Nix-store install, which is read-only by construction.
  posixTest("--no-cache on a read-only engine dir keeps the cached binary", async () => {
    if (process.getuid?.() === 0) return; // root writes through the mode bits
    const binPath = stageInstalledEngine("kesha-nocache-readonly-");
    chmodSync(dirname(binPath), 0o555);
    const urls = stubRelease();

    await installEngine({ noCache: true });

    expect(engineDownloads(urls)).toHaveLength(0);
    // The flag is still forwarded: only the engine binary is uncacheable here, not the models.
    expect(engineInvocations().find((a) => a.startsWith("install"))).toContain("--no-cache");
  }, 30_000);
});

describe("a download that never starts", () => {
  posixTest("a fetch that throws blames the network and keeps the old binary", async () => {
    const binPath = stageEmptyEngineDir("kesha-fetch-throws-");
    writeFileSync(binPath, "previous engine");
    writeFileSync(`${binPath}.version`, "1.0.0\n");
    globalThis.fetch = (async (_input: Request | URL | string): Promise<Response> => {
      throw new Error("getaddrinfo ENOTFOUND github.com");
    }) as typeof fetch;

    // The cause has to survive: "download failed" without the DNS failure is not actionable.
    await expect(installEngine()).rejects.toThrow(/ENOTFOUND/);

    expect(readFileSync(binPath, "utf8")).toBe("previous engine");
  }, 30_000);
});

describe("Kokoro warmup follows the languages asked for", () => {
  darwinArmTest("a Russian-only install warms nothing — ru routes through Vosk", async () => {
    stageInstalledEngine("kesha-warm-ru-");
    stubRelease();

    await installEngine({ ttsLangs: ["ru"] });

    expect(engineInvocations().some((a) => a.startsWith("say"))).toBe(false);
  }, 60_000);

  darwinArmTest("an English install warms the Kokoro cache", async () => {
    stageInstalledEngine("kesha-warm-en-");
    stubRelease();

    await installEngine({ ttsLangs: ["en"] });

    expect(engineInvocations().some((a) => a.startsWith("say"))).toBe(true);
  }, 60_000);

  // The warmup is an optimisation; a failing one must not cost the user their install.
  darwinArmTest("a warmup that fails leaves the install successful", async () => {
    stageInstalledEngine("kesha-warm-fails-", { sayExit: 3 });
    stubRelease();

    await installEngine({ ttsLangs: ["en"] });

    expect(engineInvocations().some((a) => a.startsWith("say"))).toBe(true);
  }, 60_000);
});

describe("sidecar failures cannot fail the engine install", () => {
  darwinArmTest("a sidecar that 404s still leaves a working engine", async () => {
    const binPath = stageEmptyEngineDir("kesha-sidecar-404-");
    const body = engineScript();
    const binaryName = getEngineBinaryName();
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.endsWith(binaryName)
        ? new Response(body, {
            status: 200,
            headers: { "content-length": String(Buffer.byteLength(body)) },
          })
        : new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    await installEngine();

    expect(existsSync(binPath)).toBe(true);
    expect(existsSync(join(dirname(binPath), SIDECARS[0]!.fileBasename))).toBe(false);
  }, 60_000);

  darwinArmTest("a sidecar whose fetch throws still leaves a working engine", async () => {
    const binPath = stageEmptyEngineDir("kesha-sidecar-throws-");
    const body = engineScript();
    const binaryName = getEngineBinaryName();
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith(binaryName)) throw new Error("socket hang up");
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(body)) },
      });
    }) as typeof fetch;

    await installEngine();

    expect(existsSync(binPath)).toBe(true);
  }, 60_000);
});
