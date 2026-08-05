import { afterEach, describe, expect, test } from "bun:test";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  downloadEngine,
  getEngineBinaryName,
  installEngine,
  readInstalledEngineVersion,
  type InstallOptions,
} from "../../src/engine-install";
import { resolveEngineVersionFlag } from "../../src/cli/install";
import { engineVersion } from "../../src/package-info";

const OVERRIDE = "9.9.9-alpha.1";
const FAKE_ENGINE = "#!/bin/sh\nexit 0\n";

const savedEnv = { KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN };
const savedFetch = globalThis.fetch;
const tempDirs: string[] = [];

// The fake engine is a shell script, which Windows cannot spawn.
const posixTest = process.platform === "win32" ? test.skip : test;

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedEnv.KESHA_ENGINE_BIN === undefined) delete process.env.KESHA_ENGINE_BIN;
  else process.env.KESHA_ENGINE_BIN = savedEnv.KESHA_ENGINE_BIN;
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(join(dir, "bin"), 0o755);
    } catch {
      // only the read-only case created that directory
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function stageEngineDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  const binPath = join(dir, "bin", "kesha-engine");
  mkdirSync(join(dir, "bin"), { recursive: true });
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

/** Serves the engine asset for `available` releases and 404s everything else, recording every URL. */
function stubReleases(available: string[]): string[] {
  const urls: string[] = [];
  const binaryName = getEngineBinaryName();
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const served = available.some((v) => url.endsWith(`/download/v${v}/${binaryName}`));
    return served
      ? new Response(FAKE_ENGINE, {
          status: 200,
          headers: { "content-length": String(FAKE_ENGINE.length) },
        })
      : new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  return urls;
}

function engineDownloads(urls: string[]): string[] {
  const binaryName = getEngineBinaryName();
  return urls.filter((u) => u.endsWith(binaryName));
}

describe("resolveEngineVersionFlag", () => {
  test("accepts exact releases and prereleases", () => {
    expect(resolveEngineVersionFlag("1.24.8")).toBe("1.24.8");
    expect(resolveEngineVersionFlag("1.24.8-alpha.1")).toBe("1.24.8-alpha.1");
    expect(resolveEngineVersionFlag(" 1.24.8 ")).toBe("1.24.8");
  });

  test("an absent flag leaves the pin in charge", () => {
    expect(resolveEngineVersionFlag(undefined)).toBeUndefined();
    expect(resolveEngineVersionFlag(false)).toBeUndefined();
  });

  test("rejects anything that is not an exact version", () => {
    expect(() => resolveEngineVersionFlag("latest")).toThrow(/exact version/);
    expect(() => resolveEngineVersionFlag("1.24")).toThrow(/exact version/);
    expect(() => resolveEngineVersionFlag("")).toThrow(/exact version/);
  });

  // Rejected here rather than left to 404 at the release URL.
  test("rejects prerelease identifiers SemVer itself rejects", () => {
    expect(() => resolveEngineVersionFlag("1.0.0-01")).toThrow(/exact version/);
    expect(() => resolveEngineVersionFlag("1.0.0-..")).toThrow(/exact version/);
    expect(() => resolveEngineVersionFlag("1.0.0-")).toThrow(/exact version/);
    expect(resolveEngineVersionFlag("1.0.0-alpha.0")).toBe("1.0.0-alpha.0");
  });

  test("a tag-shaped value names the leading v as the problem", () => {
    expect(() => resolveEngineVersionFlag("v1.24.8")).toThrow(/leading "v"/);
  });
});

describe("installEngine --engine-version (#738)", () => {
  posixTest("one override reaches the URL, the recorded version and the cache check", async () => {
    const binPath = stageEngineDir("kesha-engine-override-");
    const urls = stubReleases([OVERRIDE]);

    await installEngine({ version: OVERRIDE });

    expect(engineDownloads(urls)).toHaveLength(1);
    expect(urls[0]).toContain(`/download/v${OVERRIDE}/`);
    expect(urls.some((u) => u.includes(`/download/v${engineVersion}/`))).toBe(false);
    expect(readInstalledEngineVersion(binPath)).toBe(OVERRIDE);

    // The cache comparison must use the requested version too, or this reinstall
    // would decide the override is stale and replace it with the pin.
    await installEngine({ version: OVERRIDE });
    expect(engineDownloads(urls)).toHaveLength(1);
    expect(readInstalledEngineVersion(binPath)).toBe(OVERRIDE);
  }, 30_000);

  posixTest("the darwin sidecars follow the requested version", async () => {
    if (!(process.platform === "darwin" && process.arch === "arm64")) return;
    stageEngineDir("kesha-engine-override-sidecar-");
    const urls = stubReleases([OVERRIDE]);

    await installEngine({ version: OVERRIDE });

    const sidecarUrls = urls.filter((u) => u.includes("say-avspeech") || u.includes("kesha-textlang"));
    expect(sidecarUrls.length).toBeGreaterThan(0);
    for (const url of sidecarUrls) expect(url).toContain(`/download/v${OVERRIDE}/`);
  }, 30_000);

  posixTest("the cache-hit sidecar top-up follows the override, not the pin", async () => {
    if (!(process.platform === "darwin" && process.arch === "arm64")) return;
    const binPath = stageEngineDir("kesha-engine-override-topup-");
    const urls = stubReleases([OVERRIDE]);

    await installEngine({ version: OVERRIDE });
    // Sidecars 404 above, so nothing was staged; write one and drop the other to force a top-up.
    writeFileSync(join(binPath, "..", "say-avspeech"), "sidecar");
    urls.length = 0;

    await installEngine({ version: OVERRIDE });

    expect(engineDownloads(urls)).toHaveLength(0);
    const toppedUp = urls.filter((u) => u.includes("kesha-textlang"));
    expect(toppedUp.length).toBeGreaterThan(0);
    for (const url of toppedUp) expect(url).toContain(`/download/v${OVERRIDE}/`);
    expect(urls.some((u) => u.includes(`/download/v${engineVersion}/`))).toBe(false);
  }, 30_000);

  posixTest("a read-only engine dir whose recorded version matches still installs", async () => {
    if (process.getuid?.() === 0) return;
    const binPath = stageEngineDir("kesha-engine-readonly-match-");
    writeFileSync(binPath, FAKE_ENGINE);
    chmodSync(binPath, 0o755);
    writeFileSync(`${binPath}.version`, `${engineVersion}\n`);
    chmodSync(join(binPath, ".."), 0o555);
    const urls = stubReleases([engineVersion]);

    // The Nix store and the CI lanes both stage a matching marker precisely so this succeeds.
    await installEngine();

    expect(urls).toHaveLength(0);
    expect(readInstalledEngineVersion(binPath)).toBe(engineVersion);
  }, 30_000);

  posixTest("the public downloadEngine cannot be talked into a non-pinned version", async () => {
    const binPath = stageEngineDir("kesha-engine-public-api-");
    const urls = stubReleases([engineVersion]);

    await downloadEngine(false, undefined, { version: OVERRIDE } as InstallOptions);

    expect(urls[0]).toContain(`/download/v${engineVersion}/`);
    expect(urls.some((u) => u.includes(`/download/v${OVERRIDE}/`))).toBe(false);
    expect(readInstalledEngineVersion(binPath)).toBe(engineVersion);
  }, 30_000);

  posixTest("no override installs the pin, and a later install reverts to it", async () => {
    const binPath = stageEngineDir("kesha-engine-pinned-");
    const urls = stubReleases([engineVersion, OVERRIDE]);

    await installEngine();
    expect(engineDownloads(urls)).toHaveLength(1);
    expect(urls[0]).toContain(`/download/v${engineVersion}/`);
    expect(readInstalledEngineVersion(binPath)).toBe(engineVersion);

    await installEngine({ version: OVERRIDE });
    expect(readInstalledEngineVersion(binPath)).toBe(OVERRIDE);

    // #738: an additive install without the flag is not a sticky override.
    await installEngine({ ttsLangs: ["ru"] });
    expect(readInstalledEngineVersion(binPath)).toBe(engineVersion);
    expect(engineDownloads(urls).at(-1)).toContain(`/download/v${engineVersion}/`);
  }, 60_000);

  posixTest("an unreleased version fails by name and leaves the binary alone", async () => {
    const binPath = stageEngineDir("kesha-engine-missing-release-");
    writeFileSync(binPath, "previous engine");
    writeFileSync(`${binPath}.version`, "1.0.0\n");
    stubReleases([]);

    await expect(installEngine({ version: OVERRIDE })).rejects.toThrow(
      new RegExp(`release v${OVERRIDE.replace(/\./g, "\\.")}`),
    );

    expect(readFileSync(binPath, "utf8")).toBe("previous engine");
    expect(readInstalledEngineVersion(binPath)).toBe("1.0.0");
  }, 30_000);

  posixTest("a read-only engine directory fails by name instead of half-installing", async () => {
    if (process.getuid?.() === 0) return; // root writes through the mode bits
    const binPath = stageEngineDir("kesha-engine-readonly-");
    writeFileSync(binPath, "previous engine");
    writeFileSync(`${binPath}.version`, "1.0.0\n");
    const engineDir = join(binPath, "..");
    chmodSync(engineDir, 0o555);
    try {
      accessSync(engineDir, constants.W_OK);
      return; // the filesystem ignored the mode bits, so there is nothing to assert
    } catch {
      // read-only as intended
    }
    const urls = stubReleases([OVERRIDE]);

    await expect(installEngine({ version: OVERRIDE })).rejects.toThrow(/is not writable/);

    expect(urls).toHaveLength(0);
    expect(readInstalledEngineVersion(binPath)).toBe("1.0.0");
  }, 30_000);
});
