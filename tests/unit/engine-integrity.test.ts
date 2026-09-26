import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  getEngineBinaryName,
  getVersionMarkerPath,
  installEngine,
  readInstalledEngineVersion,
  SIDECARS,
} from "../../src/engine-install";
import { getEngineBinPath } from "../../src/engine";
import { isDarwinArm64 } from "../../src/engine-targets";
import { engineVersion } from "../../src/package-info";
import { describeJson, expectServedBody, isolateEngineCache } from "../helpers/fake-engine";
import { tempDir } from "../helpers/temp-dir";

const OVERRIDE = "9.9.9-alpha.1";
const ENGINE = `#!/bin/sh
if [ "$1" = "describe" ]; then
  printf '%s\\n' '${describeJson({ backend: "onnx", features: ["tts"] })}'
fi
exit 0
`;

const savedFetch = globalThis.fetch;
let releaseCacheIsolation: () => void = () => {};

// The fake engine is a shell script, which Windows cannot spawn.
const posixTest = process.platform === "win32" ? test.skip : test;
/** Sidecars are only ever fetched on darwin-arm64. */
const sidecarTest = isDarwinArm64() ? test : test.skip;

beforeEach(() => {
  releaseCacheIsolation = isolateEngineCache();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  releaseCacheIsolation();
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stageEngineDir(): string {
  const dir = tempDir("kesha-integrity-");
  mkdirSync(join(dir, "bin"), { recursive: true });
  const binPath = join(dir, "bin", "kesha-engine");
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

/** Serves ENGINE as the engine asset and `sums` (or a 404) as SHA256SUMS; every URL asked for is recorded. */
function stubRelease(sums: string | null): string[] {
  const urls: string[] = [];
  const binaryName = getEngineBinaryName();
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url.endsWith("/SHA256SUMS")) {
      return sums === null ? new Response("Not Found", { status: 404 }) : new Response(sums, { status: 200 });
    }
    if (url.endsWith(`/${binaryName}`) || SIDECARS.some((s) => url.endsWith(`/${s.assetName}`))) {
      return new Response(ENGINE, { status: 200, headers: { "content-length": String(ENGINE.length) } });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  return urls;
}

function sumsLine(hash: string): string {
  return `${hash}  ./${getEngineBinaryName()}\n`;
}

describe("the engine binary is installed only when its SHA-256 matches", () => {
  // The release's own SHA256SUMS vouches for the served bytes here, so only the pin can refuse them.
  posixTest("the pinned release refuses a binary whose hash is not the pin, and keeps no copy of it", async () => {
    const binPath = stageEngineDir();
    stubRelease(sumsLine(sha256(ENGINE)));

    const err = await installEngine().then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`expected sha256`);
    expect((err as Error).message).toContain(`got ${sha256(ENGINE)}`);
    expect(existsSync(binPath)).toBe(false);
    expect(existsSync(getVersionMarkerPath(binPath))).toBe(false);
  }, 30_000);

  posixTest("a failed check also removes the marker a previous install left", async () => {
    const binPath = stageEngineDir();
    writeFileSync(binPath, "#!/bin/sh\nexit 1\n");
    writeFileSync(getVersionMarkerPath(binPath), "1.0.0\n");
    stubRelease(null);

    await expect(installEngine()).rejects.toThrow(/sha256/i);

    expect(existsSync(binPath)).toBe(false);
    expect(existsSync(getVersionMarkerPath(binPath))).toBe(false);
  }, 30_000);

  posixTest("an overridden release installs when its SHA256SUMS vouches for the binary", async () => {
    const binPath = stageEngineDir();
    stubRelease(`${sha256("other")}  ./SHA256SUMS.sigstore.json\n${sumsLine(sha256(ENGINE))}`);

    await installEngine({ version: OVERRIDE });

    expect(readInstalledEngineVersion(binPath)).toBe(OVERRIDE);
  }, 30_000);

  posixTest("an overridden release refuses a binary its SHA256SUMS does not vouch for", async () => {
    const binPath = stageEngineDir();
    const wrong = sha256("a different binary");
    stubRelease(sumsLine(wrong));

    await expect(installEngine({ version: OVERRIDE })).rejects.toThrow(
      `expected sha256 ${wrong}, got ${sha256(ENGINE)}`,
    );
    expect(existsSync(binPath)).toBe(false);
  }, 30_000);

  posixTest("an overridden release without SHA256SUMS is refused before its binary is downloaded", async () => {
    const binPath = stageEngineDir();
    const urls = stubRelease(null);

    await expect(installEngine({ version: OVERRIDE })).rejects.toThrow(
      `release v${OVERRIDE} publishes no SHA256SUMS`,
    );
    expect(urls.filter((u) => u.endsWith(`/${getEngineBinaryName()}`))).toEqual([]);
    expect(existsSync(binPath)).toBe(false);
  }, 30_000);

  sidecarTest("a sidecar that does not match is discarded while the verified engine still installs", async () => {
    const binPath = stageEngineDir();
    const [mismatched, matching] = SIDECARS;
    stubRelease(
      sumsLine(sha256(ENGINE)) +
        `${sha256("not the served sidecar")}  ./${mismatched!.assetName}\n` +
        `${sha256(ENGINE)}  ./${matching!.assetName}\n`,
    );

    await installEngine({ version: OVERRIDE });

    expect(readInstalledEngineVersion(binPath)).toBe(OVERRIDE);
    expect(existsSync(join(dirname(binPath), mismatched!.fileBasename))).toBe(false);
    expect(existsSync(join(dirname(binPath), matching!.fileBasename))).toBe(true);
  }, 30_000);

  posixTest("kesha install renders the refusal and exits 1", async () => {
    const binPath = stageEngineDir();
    const dir = tempDir("kesha-integrity-cli-");
    const script = join(dir, "install.ts");
    writeFileSync(
      script,
      `import { performInstall } from ${JSON.stringify(join(import.meta.dir, "../../src/cli/install.ts"))};\n` +
        `const body = ${JSON.stringify(ENGINE)};\n` +
        `globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;\n` +
        `await performInstall({ noCache: false, ttsLangs: [] });\n`,
    );
    const proc = Bun.spawn([process.execPath, script], {
      env: { ...process.env, KESHA_ENGINE_BIN: binPath },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `kesha-engine binary ${getEngineBinaryName()} from release v${engineVersion} does not match its pinned SHA-256`,
    );
    expect(stderr).toContain("Fix: re-run `kesha install`");
    expect(existsSync(binPath)).toBe(false);
  }, 30_000);
});

/** An engine that runs and describes itself like the real one, but is not the bytes any release published. */
const ALTERED = `${ENGINE}# altered after install\n`;

/** Stages a cache-valid install of the pinned version whose engine and sidecars are ALTERED. */
function stageAlteredInstall(binPath: string): void {
  mkdirSync(dirname(binPath), { recursive: true });
  for (const path of [binPath, ...SIDECARS.map((s) => join(dirname(binPath), s.fileBasename))]) {
    writeFileSync(path, ALTERED);
    chmodSync(path, 0o755);
  }
  writeFileSync(getVersionMarkerPath(binPath), `${engineVersion}\n`);
}

describe("a cached install of the pinned engine is held to the pin", () => {
  posixTest("an altered engine behind a matching marker is not trusted as a cache hit", async () => {
    const binPath = getEngineBinPath();
    stageAlteredInstall(binPath);
    stubRelease(null);

    await expect(installEngine()).rejects.toThrow("does not match its pinned SHA-256");

    expect(existsSync(binPath)).toBe(false);
    expect(existsSync(getVersionMarkerPath(binPath))).toBe(false);
  }, 30_000);

  posixTest("an altered engine is replaced by a verified download", async () => {
    const binPath = getEngineBinPath();
    stageAlteredInstall(binPath);
    stubRelease(null);
    expectServedBody(() => ENGINE);

    await installEngine();

    expect(readFileSync(binPath, "utf8")).toBe(ENGINE);
    expect(readInstalledEngineVersion(binPath)).toBe(engineVersion);
  }, 30_000);

  sidecarTest("an altered sidecar next to a verified engine is replaced by a verified download", async () => {
    const binPath = getEngineBinPath();
    stageAlteredInstall(binPath);
    writeFileSync(binPath, ENGINE);
    stubRelease(null);
    expectServedBody(() => ENGINE);

    await installEngine();

    for (const spec of SIDECARS) {
      expect(readFileSync(join(dirname(binPath), spec.fileBasename), "utf8")).toBe(ENGINE);
    }
  }, 30_000);

  posixTest("an engine the user supplied through KESHA_ENGINE_BIN is their own build and is not held to the pin", async () => {
    const binPath = stageEngineDir();
    stageAlteredInstall(binPath);
    stubRelease(null);

    await installEngine();

    expect(readFileSync(binPath, "utf8")).toBe(ALTERED);
  }, 30_000);
});
