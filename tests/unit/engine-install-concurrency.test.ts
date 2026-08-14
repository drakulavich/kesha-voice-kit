import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { installEngine, readInstalledEngineVersion } from "../../src/engine-install";
import { log } from "../../src/log";
import { isolateEngineCache } from "../helpers/fake-engine";

const VERSION_A = "9.9.9-alpha.1";
const VERSION_B = "9.9.8";

/**
 * Answers `--capabilities-json`, `install` and `say`. `install` brackets itself in `log` so a
 * test can see whether two installs were inside the engine at once, and holds the cache for
 * `KESHA_TEST_INSTALL_SLEEP` seconds so the overlap window is set by the test, not by timing.
 * `extraInstallBody` stands in for a writer the lock cannot cover.
 */
function engineScript(logPath: string, extraInstallBody = ""): string {
  return `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '{"protocolVersion":3,"backend":"onnx","features":["tts"]}'
  exit 0
fi
if [ "$1" = "install" ]; then
  echo "enter $$" >> '${logPath}'
${extraInstallBody}
  sleep \${KESHA_TEST_INSTALL_SLEEP:-0}
  echo "exit $$" >> '${logPath}'
  exit 0
fi
exit 0
`;
}

const savedFetch = globalThis.fetch;
const savedSuccess = log.success;
const tempDirs: string[] = [];
let releaseCacheIsolation: () => void = () => {};
let engineLog = "";

// The stub engine is a shell script, which Windows cannot spawn.
const posixTest = process.platform === "win32" ? test.skip : test;

beforeEach(() => {
  releaseCacheIsolation = isolateEngineCache();
  const dir = mkdtempSync(join(tmpdir(), "kesha-install-race-log-"));
  tempDirs.push(dir);
  engineLog = join(dir, "engine.log");
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  log.success = savedSuccess;
  releaseCacheIsolation();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stageEngineDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const binPath = join(dir, "bin", "kesha-engine");
  process.env.KESHA_ENGINE_BIN = binPath;
  return binPath;
}

/** Serves the stub engine for every release asset. */
function stubReleases(extraInstallBody = ""): void {
  const body = engineScript(engineLog, extraInstallBody);
  globalThis.fetch = (async (_input: Request | URL | string): Promise<Response> =>
    new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    })) as typeof fetch;
}

interface SuccessClaim {
  claimed: string;
  onDisk: string | null;
}

/**
 * Records what each "installed successfully" line claimed alongside the version recorded at
 * that instant. #997 is about the truth of that message when it is printed, which no
 * after-the-fact read of the cache can reconstruct.
 */
function captureSuccessClaims(binPath: string): SuccessClaim[] {
  const claims: SuccessClaim[] = [];
  log.success = (msg: string) => {
    const m = /Backend installed successfully \(engine v(.+)\)/.exec(msg);
    if (m?.[1]) claims.push({ claimed: m[1], onDisk: readInstalledEngineVersion(binPath) });
    savedSuccess(msg);
  };
  return claims;
}

/** A second `kesha install` process against the same cache, holding the engine for `holdSecs`. */
function spawnPeerInstall(version: string, holdSecs: number) {
  const dir = mkdtempSync(join(tmpdir(), "kesha-install-peer-"));
  tempDirs.push(dir);
  const script = join(dir, "peer-install.ts");
  const body = engineScript(engineLog);
  writeFileSync(
    script,
    `import { installEngine } from ${JSON.stringify(join(import.meta.dir, "../../src/engine-install.ts"))};\n` +
      `const body = ${JSON.stringify(body)};\n` +
      `globalThis.fetch = (async () => new Response(body, { status: 200, headers: { "content-length": String(Buffer.byteLength(body)) } })) as typeof fetch;\n` +
      `await installEngine({ version: ${JSON.stringify(version)} });\n`,
  );
  return Bun.spawn([process.execPath, script], {
    // Bun snapshots env at spawn, so the cache redirection has to be passed explicitly.
    env: { ...process.env, KESHA_TEST_INSTALL_SLEEP: String(holdSecs) },
    stdout: "ignore",
    stderr: "pipe",
  });
}

/** Blocks until the engine log shows an install has entered the engine. */
async function waitForPeerInsideEngine(deadlineMs = 20_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(engineLog) && readFileSync(engineLog, "utf8").includes("enter ")) return;
    await Bun.sleep(25);
  }
  throw new Error("the peer install never reached the engine");
}

/** True when two installs were inside the engine at the same time. */
function installsOverlapped(): boolean {
  const lines = existsSync(engineLog) ? readFileSync(engineLog, "utf8").split("\n").filter(Boolean) : [];
  let inside = 0;
  for (const line of lines) {
    inside += line.startsWith("enter") ? 1 : -1;
    if (inside > 1) return true;
  }
  return false;
}

describe("concurrent kesha install (#997)", () => {
  posixTest("a second install waits instead of racing the one already running", async () => {
    const binPath = stageEngineDir("kesha-install-race-");
    stubReleases();
    const claims = captureSuccessClaims(binPath);
    const peer = spawnPeerInstall(VERSION_B, 3);

    await waitForPeerInsideEngine();
    await installEngine({ version: VERSION_A });
    const peerExit = await peer.exited;

    expect(installsOverlapped()).toBe(false);
    expect(peerExit).toBe(0);
    for (const claim of claims) expect(claim.onDisk).toBe(claim.claimed);
    expect(claims).toHaveLength(1);
    expect(readInstalledEngineVersion(binPath)).toBe(VERSION_A);
  }, 60_000);

  posixTest("a foreign write to the marker fails the install instead of claiming success", async () => {
    const binPath = stageEngineDir("kesha-install-foreign-");
    // A writer no lock can cover: a manual cache edit, or an install that predates the lock.
    stubReleases(`  printf '%s\\n' '1.0.0' > "$0.version"`);
    const claims = captureSuccessClaims(binPath);

    await expect(installEngine({ version: VERSION_A })).rejects.toThrow(/E_INSTALL_RACE/);

    expect(claims).toEqual([]);
  }, 30_000);

  posixTest("an install killed mid-flight does not wedge the next one", async () => {
    const binPath = stageEngineDir("kesha-install-killed-peer-");
    stubReleases();
    const peer = spawnPeerInstall(VERSION_B, 5);

    await waitForPeerInsideEngine();
    peer.kill("SIGKILL");
    await peer.exited;

    await installEngine({ version: VERSION_A });

    expect(readInstalledEngineVersion(binPath)).toBe(VERSION_A);
  }, 60_000);

  posixTest("a failed install leaves the next one able to run", async () => {
    const binPath = stageEngineDir("kesha-install-release-");
    globalThis.fetch = (async (_input: Request | URL | string): Promise<Response> =>
      new Response("Not Found", { status: 404 })) as typeof fetch;

    await expect(installEngine({ version: VERSION_A })).rejects.toThrow(/HTTP 404/);

    stubReleases();
    await installEngine({ version: VERSION_A });

    expect(readInstalledEngineVersion(binPath)).toBe(VERSION_A);
  }, 30_000);
});
