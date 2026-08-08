import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getEngineBinaryName, installEngine } from "../../src/engine-install";
import { probeCapabilitiesForInstall } from "../../src/cli/install";
import { probeExecutable } from "../../src/engine-health";
import { getEngineCapabilities } from "../../src/engine";
import { engineVersion } from "../../src/package-info";

// #770: an interrupted `kesha install` left a truncated binary that the kernel refuses to
// load, while the `.version` marker still vouched for it. Every repair path then failed.

const WORKING_ENGINE = "#!/bin/sh\nexit 0\n";
/** Mode 0o755 but not a loadable image: `posix_spawn` fails with ENOEXEC, as on a truncated Mach-O. */
const CORRUPT_ENGINE = "\x7fELF\x00\x01\x02truncated";

const savedEnv = { KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN };
const savedFetch = globalThis.fetch;
const tempDirs: string[] = [];

const posixTest = process.platform === "win32" ? test.skip : test;

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedEnv.KESHA_ENGINE_BIN === undefined) delete process.env.KESHA_ENGINE_BIN;
  else process.env.KESHA_ENGINE_BIN = savedEnv.KESHA_ENGINE_BIN;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Installs a binary at the pinned version, so only its health can decide the cache check. */
function stageEngine(prefix: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  const binPath = join(dir, "bin", "kesha-engine");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(binPath, body);
  chmodSync(binPath, 0o755);
  writeFileSync(`${binPath}.version`, `${engineVersion}\n`);
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

function stubRelease(): string[] {
  const urls: string[] = [];
  const binaryName = getEngineBinaryName();
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    return url.endsWith(binaryName)
      ? new Response(WORKING_ENGINE, {
          status: 200,
          headers: { "content-length": String(WORKING_ENGINE.length) },
        })
      : new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  return urls;
}

function engineDownloads(urls: string[]): string[] {
  const binaryName = getEngineBinaryName();
  return urls.filter((u) => u.endsWith(binaryName));
}

describe("probeExecutable (#770)", () => {
  posixTest("a binary that runs is healthy whatever it exits with", async () => {
    const binPath = stageEngine("kesha-probe-ok-", "#!/bin/sh\nexit 3\n");
    expect(await probeExecutable(binPath, ["--version"])).toEqual({ status: "ok" });
  });

  posixTest("a truncated image is unusable, not merely present", async () => {
    const binPath = stageEngine("kesha-probe-corrupt-", CORRUPT_ENGINE);
    const health = await probeExecutable(binPath, ["--version"]);
    expect(health.status).toBe("unusable");
  });

  test("an absent binary is missing, not unusable", async () => {
    expect(await probeExecutable(join(tmpdir(), "kesha-does-not-exist"))).toEqual({
      status: "missing",
    });
  });
});

describe("install repairs a corrupt engine (#770)", () => {
  posixTest("a matching version marker no longer vouches for a binary that cannot run", async () => {
    const binPath = stageEngine("kesha-repair-corrupt-", CORRUPT_ENGINE);
    const urls = stubRelease();

    await installEngine();

    expect(engineDownloads(urls)).toHaveLength(1);
    expect(readFileSync(binPath, "utf8")).toBe(WORKING_ENGINE);
  }, 30_000);

  posixTest("a healthy cached engine is still not re-downloaded", async () => {
    stageEngine("kesha-repair-healthy-", WORKING_ENGINE);
    const urls = stubRelease();

    await installEngine();

    expect(engineDownloads(urls)).toHaveLength(0);
  }, 30_000);

  // The probe used to run before any install work and threw E_ENGINE_SPAWN, so the command
  // died recommending the very command the user had just run.
  posixTest("the pre-install capabilities probe survives an unspawnable engine", async () => {
    stageEngine("kesha-repair-caps-", CORRUPT_ENGINE);

    await expect(getEngineCapabilities()).rejects.toThrow(/E_ENGINE_SPAWN/);
    expect(await probeCapabilitiesForInstall()).toBeNull();
  });
});
