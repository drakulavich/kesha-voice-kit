import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { getEngineBinaryName, installEngine, SIDECARS } from "../../src/engine-install";
import { installableTtsLangs, probeCapabilitiesForInstall, resolveTtsLangs } from "../../src/cli/install";
import { engineFunctionalHealth, probeExecutable } from "../../src/engine-health";
import { getEngineCapabilities } from "../../src/engine";
import { isDarwinArm64 } from "../../src/fluid-kokoro-cache";
import { engineVersion } from "../../src/package-info";
import { isolateEngineCache } from "../helpers/fake-engine";

// #770: an interrupted `kesha install` left a truncated binary that the kernel refuses to
// load, while the `.version` marker still vouched for it. Every repair path then failed.

const WORKING_ENGINE = `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '{"protocolVersion":3,"backend":"onnx","features":[]}'
fi
exit 0
`;
/** Mode 0o755 but not a loadable image: `posix_spawn` fails with ENOEXEC, as on a truncated Mach-O. */
const CORRUPT_ENGINE = "\x7fELF\x00\x01\x02truncated";
/** The #796 stub verbatim: it spawns and exits 0, and describes nothing (#801). */
const MUTE_ENGINE = "#!/bin/sh\nexit 0\n";
const BABBLING_ENGINE = `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' 'not json'
fi
exit 0
`;
/**
 * `exec` so the terminate signal lands on `sleep` itself, not on a shell that ignores it.
 * The duration doubles as a per-test marker, so one hang test never observes another's child.
 */
function hangingEngine(marker: string): string {
  return `#!/bin/sh\nexec sleep ${marker}\n`;
}
const SLOW_ENGINE = `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  sleep 1
  printf '%s\\n' '{"protocolVersion":3,"backend":"onnx","features":[]}'
fi
exit 0
`;

async function sleepingEngineSurvives(marker: string): Promise<boolean> {
  const proc = Bun.spawn(["pgrep", "-f", `sleep ${marker}`], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim().length > 0;
}

const savedFetch = globalThis.fetch;
const tempDirs: string[] = [];
let releaseCacheIsolation: () => void = () => {};

const posixTest = process.platform === "win32" ? test.skip : test;
/** Sidecars are only ever fetched on darwin-arm64, so only there can their repair be observed. */
const sidecarTest = isDarwinArm64() ? test : test.skip;

beforeEach(() => {
  releaseCacheIsolation = isolateEngineCache();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  releaseCacheIsolation();
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

/** Serves `WORKING_ENGINE` for the engine asset, and for the sidecars too when `withSidecars`. */
function stubRelease(withSidecars = false): string[] {
  const urls: string[] = [];
  const binaryName = getEngineBinaryName();
  const served = [binaryName, ...(withSidecars ? SIDECARS.map((s) => s.assetName) : [])];
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    return served.some((name) => url.endsWith(name))
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

// #801: the developer machine's engine was MUTE_ENGINE for weeks and every health surface
// called it fine, because exit 0 was the whole test.
describe("engineFunctionalHealth (#801)", () => {
  posixTest("an engine that runs but describes nothing is mute, not ok", async () => {
    stageEngine("kesha-functional-mute-", MUTE_ENGINE);
    const health = await engineFunctionalHealth();
    expect(health.status).toBe("mute");
  });

  posixTest("capabilities that do not parse are the same fault as none at all", async () => {
    stageEngine("kesha-functional-babble-", BABBLING_ENGINE);
    const health = await engineFunctionalHealth();
    expect(health.status).toBe("mute");
  });

  posixTest("an engine that describes itself is functional, and hands back what it said", async () => {
    stageEngine("kesha-functional-ok-", WORKING_ENGINE);
    const health = await engineFunctionalHealth();
    expect(health.status).toBe("ok");
    expect(health.status === "ok" && health.capabilities.backend).toBe("onnx");
  });

  test("an absent engine is missing, never mute — nothing to repair is not a fault", async () => {
    process.env.KESHA_ENGINE_BIN = join(tmpdir(), "kesha-does-not-exist", "kesha-engine");
    expect(await engineFunctionalHealth()).toEqual({ status: "missing" });
  });

  posixTest("a binary the loader refuses stays unusable, distinct from mute", async () => {
    stageEngine("kesha-functional-corrupt-", CORRUPT_ENGINE);
    const health = await engineFunctionalHealth();
    expect(health.status).toBe("unusable");
  });

  // The capabilities probe is the primary one, so it carries the deadline the `--version`
  // probe has had since #775 — otherwise a hung binary stalls doctor, status and the
  // install cache check for as long as it likes.
  posixTest("a binary that hangs is unusable within the deadline, never mute", async () => {
    stageEngine("kesha-functional-hang-", hangingEngine("61.5"));

    const startedAt = performance.now();
    const health = await engineFunctionalHealth(500);
    const elapsed = performance.now() - startedAt;

    expect(health.status).toBe("unusable");
    expect(health.status === "unusable" && health.detail).toContain("no exit within");
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  posixTest("the hung engine is killed, not left running behind us", async () => {
    stageEngine("kesha-functional-hang-kill-", hangingEngine("62.5"));

    await engineFunctionalHealth(500);

    // SIGTERM first, SIGKILL after a 1s grace, so give the tree time to actually go.
    for (let i = 0; i < 30 && (await sleepingEngineSurvives("62.5")); i++) await Bun.sleep(100);
    expect(await sleepingEngineSurvives("62.5")).toBe(false);
  }, 15_000);

  posixTest("an engine that answers slowly is ok, not timed out", async () => {
    stageEngine("kesha-functional-slow-", SLOW_ENGINE);
    const health = await engineFunctionalHealth(10_000);
    expect(health.status).toBe("ok");
  }, 20_000);
});

describe("install repairs a corrupt engine (#770)", () => {
  posixTest("a matching version marker no longer vouches for a binary that cannot run", async () => {
    const binPath = stageEngine("kesha-repair-corrupt-", CORRUPT_ENGINE);
    const urls = stubRelease();

    await installEngine();

    expect(engineDownloads(urls)).toHaveLength(1);
    expect(readFileSync(binPath, "utf8")).toBe(WORKING_ENGINE);
  }, 30_000);

  // #801: exit 0 satisfied the #770 probe, so the marker vouched for a binary that
  // could not answer a single question about itself.
  posixTest("a cached engine that describes nothing is re-downloaded, marker or not", async () => {
    const binPath = stageEngine("kesha-repair-mute-", MUTE_ENGINE);
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

  // A cache hit used to top up only ABSENT sidecars, so a truncated one was re-trusted
  // forever and doctor's "re-run kesha install" hint was a lie for it.
  sidecarTest("a cache hit repairs a sidecar that is present but cannot run", async () => {
    const binPath = stageEngine("kesha-repair-sidecar-", WORKING_ENGINE);
    const sidecarPath = join(dirname(binPath), SIDECARS[0]!.fileBasename);
    writeFileSync(sidecarPath, CORRUPT_ENGINE);
    chmodSync(sidecarPath, 0o755);
    const urls = stubRelease(true);

    await installEngine();

    expect(engineDownloads(urls)).toHaveLength(0);
    expect(readFileSync(sidecarPath, "utf8")).toBe(WORKING_ENGINE);
  }, 60_000);
});

describe("--tts codes are validated before the engine download (#770)", () => {
  test("hi/ja/zh are only offered where the ANE engine is built", () => {
    expect(installableTtsLangs("linux", "x64")).not.toContain("ja");
    expect(installableTtsLangs("darwin", "arm64")).toContain("ja");
    expect(installableTtsLangs("darwin", "x64")).not.toContain("ja");
  });

  // Without a static list, `kesha install --tts ja` on linux downloaded a full engine and
  // only then heard "unsupported" from it.
  test("an unsupported code fails without an engine to ask", () => {
    expect(() =>
      resolveTtsLangs({ tts: true, positionals: ["ja"] }, installableTtsLangs("linux", "x64")),
    ).toThrow(/ja/);
    expect(
      resolveTtsLangs({ tts: true, positionals: ["ru"] }, installableTtsLangs("linux", "x64")),
    ).toEqual(["ru"]);
  });
});
