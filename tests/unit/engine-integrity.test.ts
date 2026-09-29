import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  engineChecksums,
  getEngineBinaryName,
  getVersionMarkerPath,
  installEngine,
  readInstalledEngineVersion,
  SIDECARS,
} from "../../src/engine-install";
import { KeshaError } from "../../src/engine/events";
import { log } from "../../src/log";
import { getEngineBinPath } from "../../src/engine";
import { downloadedAssetNames, isDarwinArm64 } from "../../src/engine-targets";
import { engineVersion } from "../../src/package-info";
import { describeJson, expectServedBody, isolateEngineCache } from "../helpers/fake-engine";
import { tempDir } from "../helpers/temp-dir";

const OVERRIDE = "9.9.9-alpha.1";
const PINNED = "7.7.7";
const ENGINE = `#!/bin/sh
if [ "$1" = "describe" ]; then
  printf '%s\\n' '${describeJson({ backend: "onnx", features: ["tts"] })}'
fi
exit 0
`;

const savedFetch = globalThis.fetch;
const savedWarn = log.warn;
let releaseCacheIsolation: () => void = () => {};

// The fake engine is a shell script, which Windows cannot spawn.
const posixTest = process.platform === "win32" ? test.skip : test;
/** Sidecars are only ever fetched on darwin-arm64. */
const sidecarTest = isDarwinArm64() ? test : test.skip;
const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
const readOnlyTest = canChmod ? test : test.skip;
const readOnlySidecarTest = canChmod && isDarwinArm64() ? test : test.skip;
let readOnlyDirs: string[] = [];

function makeReadOnly(dir: string): void {
  chmodSync(dir, 0o555);
  readOnlyDirs.push(dir);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** What a published CLI injects: every asset of its Engine pinned to bytes no stub here serves. */
const PINS = {
  version: PINNED,
  sha256: Object.fromEntries(downloadedAssetNames().map((name) => [name, sha256(`published ${name}`)])),
  size: Object.fromEntries(downloadedAssetNames().map((name) => [name, 1])),
};

beforeEach(() => {
  releaseCacheIsolation = isolateEngineCache();
  engineChecksums.pins = PINS;
});

afterEach(() => {
  for (const dir of readOnlyDirs) chmodSync(dir, 0o755);
  readOnlyDirs = [];
  globalThis.fetch = savedFetch;
  log.warn = savedWarn;
  releaseCacheIsolation();
});

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
    const urls = stubRelease(sumsLine(sha256(ENGINE)));

    const err = await installEngine({ version: PINNED }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`expected sha256`);
    expect((err as Error).message).toContain(`got ${sha256(ENGINE)}`);
    expect(urls.filter((u) => u.endsWith("/SHA256SUMS"))).toEqual([]);
    expect(existsSync(binPath)).toBe(false);
    expect(existsSync(getVersionMarkerPath(binPath))).toBe(false);
  }, 30_000);

  posixTest("a failed check also removes the marker a previous install left", async () => {
    const binPath = stageEngineDir();
    writeFileSync(binPath, "#!/bin/sh\nexit 1\n");
    writeFileSync(getVersionMarkerPath(binPath), "1.0.0\n");
    stubRelease(null);

    await expect(installEngine({ version: PINNED })).rejects.toThrow(/sha256/i);

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

  // Greptile P2 on #1263: the previous release's helper would otherwise run beside the new engine unverified.
  sidecarTest("a sidecar the new release's SHA256SUMS does not list is removed rather than kept from the old install", async () => {
    const binPath = stageEngineDir();
    for (const spec of SIDECARS) {
      const path = join(dirname(binPath), spec.fileBasename);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }
    stubRelease(sumsLine(sha256(ENGINE)));

    await installEngine({ version: OVERRIDE });

    expect(readInstalledEngineVersion(binPath)).toBe(OVERRIDE);
    for (const spec of SIDECARS) expect(existsSync(join(dirname(binPath), spec.fileBasename))).toBe(false);
  }, 30_000);

  posixTest("kesha install renders the refusal and exits 1", async () => {
    const binPath = stageEngineDir();
    const dir = tempDir("kesha-integrity-cli-");
    const script = join(dir, "install.ts");
    writeFileSync(
      script,
      `import { performInstall } from ${JSON.stringify(join(import.meta.dir, "../../src/cli/install.ts"))};\n` +
        `import { engineChecksums } from ${JSON.stringify(join(import.meta.dir, "../../src/engine-install.ts"))};\n` +
        `engineChecksums.pins = ${JSON.stringify(PINS)};\n` +
        `const body = ${JSON.stringify(ENGINE)};\n` +
        `globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;\n` +
        `await performInstall({ noCache: false, ttsLangs: [], engineVersion: ${JSON.stringify(PINNED)} });\n`,
    );
    const proc = Bun.spawn([process.execPath, script], {
      env: { ...process.env, KESHA_ENGINE_BIN: binPath },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `kesha-engine binary ${getEngineBinaryName()} from release v${PINNED} does not match its pinned SHA-256`,
    );
    expect(stderr).toContain("hint: re-run `kesha install`");
    expect(existsSync(binPath)).toBe(false);
  }, 30_000);
});

/** An engine that runs and describes itself like the real one, but is not the bytes any release published. */
const ALTERED = `${ENGINE}# altered after install\n`;

/** Stages a cache-valid install of the pinned version whose engine and sidecars are ALTERED. */
function stageAlteredInstall(binPath: string, marker = PINNED): void {
  mkdirSync(dirname(binPath), { recursive: true });
  for (const path of [binPath, ...SIDECARS.map((s) => join(dirname(binPath), s.fileBasename))]) {
    writeFileSync(path, ALTERED);
    chmodSync(path, 0o755);
  }
  writeFileSync(getVersionMarkerPath(binPath), `${marker}\n`);
}

describe("a cached install of the pinned engine is held to the pin", () => {
  posixTest("an altered engine behind a matching marker is not trusted as a cache hit", async () => {
    const binPath = getEngineBinPath();
    stageAlteredInstall(binPath);
    stubRelease(null);

    await expect(installEngine({ version: PINNED })).rejects.toThrow("does not match its pinned SHA-256");

    expect(existsSync(binPath)).toBe(false);
    expect(existsSync(getVersionMarkerPath(binPath))).toBe(false);
  }, 30_000);

  posixTest("an altered engine is replaced by a verified download", async () => {
    const binPath = getEngineBinPath();
    stageAlteredInstall(binPath);
    stubRelease(null);
    expectServedBody(() => ENGINE);

    await installEngine({ version: PINNED });

    expect(readFileSync(binPath, "utf8")).toBe(ENGINE);
    expect(readInstalledEngineVersion(binPath)).toBe(PINNED);
  }, 30_000);

  sidecarTest("an altered sidecar next to a verified engine is replaced by a verified download", async () => {
    const binPath = getEngineBinPath();
    stageAlteredInstall(binPath);
    writeFileSync(binPath, ENGINE);
    stubRelease(null);
    expectServedBody(() => ENGINE);

    await installEngine({ version: PINNED });

    for (const spec of SIDECARS) {
      expect(readFileSync(join(dirname(binPath), spec.fileBasename), "utf8")).toBe(ENGINE);
    }
  }, 30_000);

  // Greptile P1 on #1263: sidecars are best-effort everywhere else, so one unreadable copy must not abort the install.
  (isDarwinArm64() && process.getuid?.() !== 0 ? test : test.skip)(
    "an unreadable cached sidecar is warned about and replaced while the install completes",
    async () => {
      const binPath = getEngineBinPath();
      stageAlteredInstall(binPath);
      writeFileSync(binPath, ENGINE);
      const [unreadable, ...rest] = SIDECARS;
      const unreadablePath = join(dirname(binPath), unreadable!.fileBasename);
      for (const spec of rest) writeFileSync(join(dirname(binPath), spec.fileBasename), ENGINE);
      chmodSync(unreadablePath, 0o000);
      const warnings: string[] = [];
      log.warn = (msg: string) => void warnings.push(msg);
      stubRelease(null);
      expectServedBody(() => ENGINE);

      await installEngine({ version: PINNED });

      expect(readFileSync(unreadablePath, "utf8")).toBe(ENGINE);
      expect(warnings.some((w) => w.includes(unreadablePath) && w.includes("EACCES"))).toBe(true);
    },
    30_000,
  );

  posixTest("an engine the user supplied through KESHA_ENGINE_BIN is their own build and is not held to the pin", async () => {
    const binPath = stageEngineDir();
    stageAlteredInstall(binPath);
    stubRelease(null);

    await installEngine({ version: PINNED });

    expect(readFileSync(binPath, "utf8")).toBe(ALTERED);
  }, 30_000);
});

async function rejectionOf(p: Promise<unknown>): Promise<KeshaError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(KeshaError);
  return err as KeshaError;
}

describe("a cached install of the pinned engine in a read-only engine dir is still held to the pin", () => {
  readOnlyTest("an altered engine is refused as E_CACHE_CORRUPT and left in place", async () => {
    const binPath = getEngineBinPath();
    const engineDir = dirname(binPath);
    stageAlteredInstall(binPath);
    for (const spec of SIDECARS) rmSync(join(engineDir, spec.fileBasename));
    makeReadOnly(engineDir);
    stubRelease(null);

    const err = await rejectionOf(installEngine({ version: PINNED }));

    expect(err.code).toBe("E_CACHE_CORRUPT");
    expect(err.message).toContain(`kesha-engine binary ${getEngineBinaryName()} at ${binPath} does not match its pinned SHA-256`);
    expect(err.message).toContain(`got ${sha256(ALTERED)}`);
    expect(err.hint).toContain(engineDir);
    expect(err.hint).toContain("writable");
    expect(err.hint).toContain("kesha install");
    expect(readFileSync(binPath, "utf8")).toBe(ALTERED);
    expect(readInstalledEngineVersion(binPath)).toBe(PINNED);
  }, 30_000);

  readOnlySidecarTest("an altered sidecar beside a verified engine is refused as E_CACHE_CORRUPT and left in place", async () => {
    const binPath = getEngineBinPath();
    const engineDir = dirname(binPath);
    stageAlteredInstall(binPath);
    writeFileSync(binPath, ENGINE);
    makeReadOnly(engineDir);
    stubRelease(null);
    expectServedBody(() => ENGINE);

    const err = await rejectionOf(installEngine({ version: PINNED }));

    expect(err.code).toBe("E_CACHE_CORRUPT");
    expect(err.message).toContain(SIDECARS[0]!.assetName);
    expect(err.hint).toContain(engineDir);
    for (const spec of SIDECARS) {
      expect(readFileSync(join(engineDir, spec.fileBasename), "utf8")).toBe(ALTERED);
    }
  }, 30_000);

  readOnlyTest("kesha install renders the refusal, exits 1 and deletes nothing", async () => {
    const binPath = getEngineBinPath();
    const engineDir = dirname(binPath);
    stageAlteredInstall(binPath);
    for (const spec of SIDECARS) rmSync(join(engineDir, spec.fileBasename));
    makeReadOnly(engineDir);
    const dir = tempDir("kesha-integrity-readonly-cli-");
    const script = join(dir, "install.ts");
    writeFileSync(
      script,
      `import { performInstall } from ${JSON.stringify(join(import.meta.dir, "../../src/cli/install.ts"))};\n` +
        `import { engineChecksums } from ${JSON.stringify(join(import.meta.dir, "../../src/engine-install.ts"))};\n` +
        `engineChecksums.pins = ${JSON.stringify(PINS)};\n` +
        `globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;\n` +
        `await performInstall({ noCache: false, ttsLangs: [], engineVersion: ${JSON.stringify(PINNED)} });\n`,
    );
    const proc = Bun.spawn([process.execPath, script], {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(stderr).toContain("error [E_CACHE_CORRUPT]: ");
    expect(stderr.slice(stderr.indexOf("hint: "))).toContain(engineDir);
    expect(exitCode).toBe(1);
    expect(readFileSync(binPath, "utf8")).toBe(ALTERED);
    expect(readInstalledEngineVersion(binPath)).toBe(PINNED);
  }, 30_000);

  readOnlySidecarTest("kesha install refuses a pinned sidecar it cannot read as E_INVALID_ARG, exits 2 and deletes nothing", async () => {
    const binPath = getEngineBinPath();
    const engineDir = dirname(binPath);
    stageAlteredInstall(binPath);
    writeFileSync(binPath, ENGINE);
    const [unreadable, ...rest] = SIDECARS;
    const unreadablePath = join(engineDir, unreadable!.fileBasename);
    for (const spec of rest) rmSync(join(engineDir, spec.fileBasename));
    chmodSync(unreadablePath, 0o000);
    makeReadOnly(engineDir);
    const pins = { ...PINS, sha256: { ...PINS.sha256, [getEngineBinaryName()]: sha256(ENGINE) } };
    const dir = tempDir("kesha-integrity-unreadable-cli-");
    const script = join(dir, "install.ts");
    writeFileSync(
      script,
      `import { performInstall } from ${JSON.stringify(join(import.meta.dir, "../../src/cli/install.ts"))};\n` +
        `import { engineChecksums } from ${JSON.stringify(join(import.meta.dir, "../../src/engine-install.ts"))};\n` +
        `engineChecksums.pins = ${JSON.stringify(pins)};\n` +
        `globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;\n` +
        `await performInstall({ noCache: false, ttsLangs: [], engineVersion: ${JSON.stringify(PINNED)} });\n`,
    );
    const proc = Bun.spawn([process.execPath, script], {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(stderr).toMatch(/^error \[E_INVALID_ARG\]: /m);
    expect(stderr.slice(0, stderr.indexOf("hint: "))).toContain(unreadablePath);
    expect(stderr.slice(stderr.indexOf("hint: "))).toContain("readable");
    expect(stderr.slice(stderr.indexOf("hint: "))).toContain("kesha install");
    expect(exitCode).toBe(2);
    expect(existsSync(unreadablePath)).toBe(true);
    expect(readFileSync(binPath, "utf8")).toBe(ENGINE);
  }, 30_000);

  readOnlyTest("a Nix-style from-source engine, which no pin describes, still installs from a read-only dir", async () => {
    engineChecksums.pins = undefined;
    const binPath = stageEngineDir();
    stageAlteredInstall(binPath, engineVersion);
    makeReadOnly(dirname(binPath));
    stubRelease(null);

    await installEngine();

    expect(readFileSync(binPath, "utf8")).toBe(ALTERED);
    expect(readInstalledEngineVersion(binPath)).toBe(engineVersion);
  }, 30_000);
});

// A source checkout carries no injected pin (openspec unified-release D1).
describe("without an injected pin, the Engine is held to its release's own SHA256SUMS", () => {
  beforeEach(() => {
    engineChecksums.pins = undefined;
  });

  posixTest("a matching SHA256SUMS installs", async () => {
    const binPath = stageEngineDir();
    stubRelease(sumsLine(sha256(ENGINE)));

    await installEngine();

    expect(readInstalledEngineVersion(binPath)).toBe(engineVersion);
  }, 30_000);

  posixTest("a mismatching SHA256SUMS refuses", async () => {
    const binPath = stageEngineDir();
    stubRelease(sumsLine(sha256("a different binary")));

    await expect(installEngine()).rejects.toThrow(`SHA256SUMS of release v${engineVersion}`);
    expect(existsSync(binPath)).toBe(false);
  }, 30_000);

  posixTest("a missing SHA256SUMS refuses", async () => {
    const binPath = stageEngineDir();
    stubRelease(null);

    await expect(installEngine()).rejects.toThrow(`release v${engineVersion} publishes no SHA256SUMS`);
    expect(existsSync(binPath)).toBe(false);
  }, 30_000);

  posixTest("a missing SHA256SUMS points to a published release instead of asking for a bug report", async () => {
    stageEngineDir();
    stubRelease(null);

    const err = await installEngine().then(
      () => null,
      (e: unknown) => e as KeshaError,
    );

    expect(err?.hint).toContain("kesha install --engine-version <version>");
    expect(err?.hint).toContain("https://github.com/drakulavich/kesha-voice-kit/releases");
    expect(err?.hint).not.toContain("report it");
  }, 30_000);

  posixTest("a SHA256SUMS that omits the engine points to a published release instead of asking for a bug report", async () => {
    stageEngineDir();
    stubRelease(`${sha256("other")}  ./some-other-asset\n`);

    const err = await installEngine().then(
      () => null,
      (e: unknown) => e as KeshaError,
    );

    expect(err?.message).toContain(`the SHA256SUMS of release v${engineVersion} does not list it`);
    expect(err?.hint).toContain("kesha install --engine-version <version>");
    expect(err?.hint).not.toContain("report it");
  }, 30_000);

  posixTest("an overridden release without SHA256SUMS asks for another published release, not the checkout's own", async () => {
    stageEngineDir();
    stubRelease(null);

    const err = await installEngine({ version: OVERRIDE }).then(
      () => null,
      (e: unknown) => e as KeshaError,
    );

    expect(err?.message).toContain(`release v${OVERRIDE} publishes no SHA256SUMS`);
    expect(err?.hint).toContain("https://github.com/drakulavich/kesha-voice-kit/releases");
    expect(err?.hint).not.toContain("this source checkout installs its own version");
    expect(err?.hint).not.toContain("without --engine-version");
  }, 30_000);
});
