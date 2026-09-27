import { describe, expect, test } from "bun:test";
import { cpSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEnginePin, newestStableRelease, PINNED_ASSETS, withEnginePin } from "../../.github/scripts/engine-pin";
import { resolveEngine } from "../../src/package-info";
import { readRepoFile, REPO_ROOT } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";

const sha = (c: string) => c.repeat(64);
const SUMS = PINNED_ASSETS.map((name, i) => `${sha("abcde"[i]!)}  ./${name}`).join("\n") + `\n${sha("f")}  ./kesha-voice-kit_2.0.0-1_amd64.deb\n`;

describe("buildEnginePin", () => {
  test("pins every Engine asset and Sidecar the installer downloads, and nothing else", () => {
    const pin = buildEnginePin("2.0.0", SUMS);
    expect(pin.version).toBe("2.0.0");
    expect(Object.keys(pin.sha256).sort()).toEqual([...PINNED_ASSETS].sort());
    expect(pin.sha256["kesha-engine-linux-x64"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses SHA256SUMS missing an asset, naming it", () => {
    const partial = SUMS.split("\n").filter((line) => !line.includes("say-avspeech")).join("\n");
    expect(() => buildEnginePin("2.0.0", partial)).toThrow("say-avspeech-darwin-arm64");
  });

  test("refuses a non-SemVer version", () => {
    expect(() => buildEnginePin("v2.0.0", SUMS)).toThrow(/SemVer/);
  });
});

describe("withEnginePin", () => {
  test("writes kesha.engine and leaves every other field alone", () => {
    const pin = buildEnginePin("2.0.0", SUMS);
    const out = JSON.parse(withEnginePin(JSON.stringify({ name: "x", version: "2.0.0", bin: { kesha: "b" } }), pin));
    expect(out).toEqual({ name: "x", version: "2.0.0", bin: { kesha: "b" }, kesha: { engine: pin } });
  });
});

describe("newestStableRelease", () => {
  const rel = (tagName: string, extra: Partial<{ isDraft: boolean; isPrerelease: boolean }> = {}) => ({
    tagName,
    isDraft: false,
    isPrerelease: false,
    ...extra,
  });

  test("picks the highest published stable version, not the newest or the Latest-marked one", () => {
    const releases = [rel("v2.1.0-alpha.3", { isPrerelease: true }), rel("v1.31.0-cli"), rel("v2.0.10"), rel("v2.0.9"), rel("v2.2.0", { isDraft: true })];
    expect(newestStableRelease(releases)).toBe("2.0.10");
  });

  test("refuses when no stable Engine release exists", () => {
    expect(() => newestStableRelease([rel("v2.0.0-beta.1", { isPrerelease: true })])).toThrow(/stable/);
  });
});

describe("resolveEngine", () => {
  const pin = { version: "2.0.0", sha256: { "kesha-engine-linux-x64": sha("a") } };

  test("an injected pin wins over every committed field", () => {
    expect(resolveEngine({ version: "2.1.0-alpha.1", kesha: { engine: pin } })).toEqual({
      version: "2.0.0",
      pins: pin,
    });
  });

  // A source checkout carries no injection, and one version names the Engine too.
  test("without an injection the package version names the Engine", () => {
    expect(resolveEngine({ version: "2.0.0" })).toEqual({ version: "2.0.0" });
  });

  test("a malformed injection is ignored rather than trusted", () => {
    expect(resolveEngine({ version: "2.0.0", kesha: { engine: { version: 2, sha256: "x" } } })).toEqual({ version: "2.0.0" });
  });
});

describe("the installer verifies against the injected pin", () => {
  // A published tarball, not this checkout: src/ beside a package.json carrying kesha.engine.
  test("a pinned asset of the injected Engine is checked against its injected SHA-256, with no network", () => {
    const dir = tempDir("kesha-injected-");
    cpSync(`${REPO_ROOT}/src`, join(dir, "src"), { recursive: true });
    symlinkSync(`${REPO_ROOT}/node_modules`, join(dir, "node_modules"));
    const pkg = JSON.parse(readRepoFile("package.json"));
    const pin = { version: "9.9.9", sha256: { "kesha-engine-linux-x64": sha("c") } };
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, kesha: { engine: pin } }));
    const probe =
      'import { releaseChecksums } from "./src/engine-install";' +
      'globalThis.fetch = () => { throw new Error("network used"); };' +
      'console.log(JSON.stringify(await releaseChecksums("9.9.9")("kesha-engine-linux-x64")));';
    const run = Bun.spawnSync(["bun", "-e", probe], { cwd: dir });
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual({ sha256: sha("c"), source: "its pinned SHA-256" });
    unlinkSync(join(dir, "node_modules"));
  });
});
