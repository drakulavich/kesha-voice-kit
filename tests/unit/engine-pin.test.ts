import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetSizes, buildEnginePin, newestStableRelease, PINNED_ASSETS, withEnginePin } from "../../.github/scripts/engine-pin";
import { engineTargetEntries, SIDECARS } from "../../src/engine-targets";
import { resolveEngine } from "../../src/package-info";
import { readRepoFile, REPO_ROOT } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";

const sha = (c: string) => c.repeat(64);
const SUMS = PINNED_ASSETS.map((name, i) => `${sha("abcde"[i]!)}  ./${name}`).join("\n") + `\n${sha("f")}  ./kesha-voice-kit_2.0.0-1_amd64.deb\n`;
const ASSETS = [...PINNED_ASSETS.map((name, i) => ({ name, size: 1000 + i })), { name: "kesha-voice-kit_2.0.0-1_amd64.deb", size: 7 }];

describe("buildEnginePin", () => {
  // A download with no pin falls back to the release's own SHA256SUMS, which an attacker who can replace the asset can replace too.
  test("covers every Engine asset and Sidecar the installer downloads", () => {
    const downloaded = [...engineTargetEntries().map(({ target }) => target.assetName), ...SIDECARS.map((s) => s.assetName)];
    expect([...PINNED_ASSETS].sort()).toEqual(downloaded.sort());
  });

  test("pins the hash and size of every downloaded asset, and nothing else", () => {
    const pin = buildEnginePin("2.0.0", SUMS, ASSETS);
    expect(pin.version).toBe("2.0.0");
    expect(Object.keys(pin.sha256).sort()).toEqual([...PINNED_ASSETS].sort());
    expect(Object.keys(pin.size).sort()).toEqual([...PINNED_ASSETS].sort());
    expect(pin.sha256["kesha-engine-linux-x64"]).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.size[PINNED_ASSETS[1]!]).toBe(1001);
  });

  test("refuses SHA256SUMS missing an asset, naming it", () => {
    const partial = SUMS.split("\n").filter((line) => !line.includes("say-avspeech")).join("\n");
    expect(() => buildEnginePin("2.0.0", partial, ASSETS)).toThrow("say-avspeech-darwin-arm64");
  });

  test("refuses an asset list with no size for an asset, naming it", () => {
    const partial = ASSETS.filter((a) => a.name !== "kesha-textlang-darwin-arm64");
    expect(() => buildEnginePin("2.0.0", SUMS, partial)).toThrow("gives no size for kesha-textlang-darwin-arm64");
  });

  test("refuses a non-SemVer version", () => {
    expect(() => buildEnginePin("v2.0.0", SUMS, ASSETS)).toThrow(/SemVer/);
  });
});

describe("assetSizes", () => {
  test("lists the files of an assembled release with their sizes, as the release API would", () => {
    const dir = tempDir("kesha-assets-");
    writeFileSync(join(dir, "kesha-engine-linux-x64"), "12345");
    writeFileSync(join(dir, "SHA256SUMS"), "");
    mkdirSync(join(dir, "nested"));
    expect(assetSizes(dir).sort((a, b) => a.size - b.size)).toEqual([
      { name: "SHA256SUMS", size: 0 },
      { name: "kesha-engine-linux-x64", size: 5 },
    ]);
  });
});

describe("withEnginePin", () => {
  test("writes kesha.engine and leaves every other field alone", () => {
    const pin = buildEnginePin("2.0.0", SUMS, ASSETS);
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
  const pin = { version: "2.0.0", sha256: { "kesha-engine-linux-x64": sha("a") }, size: { "kesha-engine-linux-x64": 5 } };

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
    expect(resolveEngine({ version: "2.0.0", kesha: { engine: { ...pin, size: { "kesha-engine-linux-x64": -1 } } } })).toEqual({ version: "2.0.0" });
  });
});

describe("the installer verifies against the injected pin", () => {
  // A published tarball, not this checkout: src/ beside a package.json carrying kesha.engine.
  test("a pinned asset of the injected Engine is checked against its injected SHA-256, with no network", () => {
    const dir = tempDir("kesha-injected-");
    cpSync(`${REPO_ROOT}/src`, join(dir, "src"), { recursive: true });
    symlinkSync(`${REPO_ROOT}/node_modules`, join(dir, "node_modules"));
    const pkg = JSON.parse(readRepoFile("package.json"));
    const pin = { version: "9.9.9", sha256: { "kesha-engine-linux-x64": sha("c") }, size: { "kesha-engine-linux-x64": 5 } };
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, kesha: { engine: pin } }));
    const probe =
      'import { engineChecksums } from "./src/engine-install";' +
      'globalThis.fetch = () => { throw new Error("network used"); };' +
      'console.log(JSON.stringify(await engineChecksums.forRelease("9.9.9")("kesha-engine-linux-x64")));';
    const run = Bun.spawnSync(["bun", "-e", probe], { cwd: dir });
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual({ sha256: sha("c"), source: "its pinned SHA-256" });
    unlinkSync(join(dir, "node_modules"));
  });
});
