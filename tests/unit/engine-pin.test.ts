import { describe, expect, test } from "bun:test";
import { buildEnginePin, newestStableRelease, PINNED_ASSETS, withEnginePin } from "../../.github/scripts/engine-pin";
import { resolveEngine } from "../../src/package-info";

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
    expect(resolveEngine({ version: "2.1.0-alpha.1", keshaEngine: { version: "1.26.0" }, kesha: { engine: pin } })).toEqual({
      version: "2.0.0",
      pins: pin,
    });
  });

  test("without an injection the committed keshaEngine pin applies, then the package version", () => {
    expect(resolveEngine({ version: "1.32.0", keshaEngine: { version: "1.26.0" } })).toEqual({ version: "1.26.0" });
    expect(resolveEngine({ version: "2.0.0" })).toEqual({ version: "2.0.0" });
  });

  test("a malformed injection is ignored rather than trusted", () => {
    expect(resolveEngine({ version: "2.0.0", kesha: { engine: { version: 2, sha256: "x" } } })).toEqual({ version: "2.0.0" });
  });
});
