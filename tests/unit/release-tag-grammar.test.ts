import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  cliPublishTarget,
  ENGINE_TAG_ERE,
  ENGINE_TAG_RE,
} from "../../.github/scripts/release-tags.mjs";

const WORKFLOW = ".github/workflows/build-engine.yml";
const WORKFLOW_YAML = readFileSync(`${import.meta.dir}/../../${WORKFLOW}`, "utf8");

const ENGINE_TAGS = ["v1.24.8", "v1.24.8-beta.1", "v1.24.8-alpha.1"];
const CLI_TAGS = ["v1.27.0-cli", "v1.27.0-alpha.1-cli"];
const NOT_TAGS = ["1.24.8", "v1.24", "v1.24.8-alpha", "v1.24.8-alpha.x", "v1.24.8; id"];

/** The grammar is one ERE string precisely so bash and JS cannot disagree about it (#685). */
async function bashAccepts(tag: string): Promise<boolean> {
  const proc = Bun.spawn(["bash", "-c", `[[ "$1" =~ ${ENGINE_TAG_ERE} ]]`, "bash", tag], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

describe("engine tag grammar", () => {
  test("accepts stable, beta and alpha engine tags", async () => {
    for (const tag of ENGINE_TAGS) {
      expect(ENGINE_TAG_RE.test(tag)).toBe(true);
      expect(await bashAccepts(tag)).toBe(true);
    }
  });

  test("rejects CLI marker tags and malformed shapes", async () => {
    for (const tag of [...CLI_TAGS, ...NOT_TAGS]) {
      expect(ENGINE_TAG_RE.test(tag)).toBe(false);
      expect(await bashAccepts(tag)).toBe(false);
    }
  });

  test("the workflow ships the grammar verbatim", () => {
    expect(WORKFLOW_YAML).toContain(ENGINE_TAG_ERE);
  });
});

describe("engine build trigger", () => {
  test("CLI marker tags are excluded from the push filter", () => {
    expect(parse(WORKFLOW_YAML).on.push.tags).toEqual(["v*", "!v*-cli"]);
  });
});

// Driven through the script because that assertion is the gate build-engine.yml runs (#696).
describe("release manifest tag check", () => {
  const pkg = JSON.parse(readFileSync(`${import.meta.dir}/../../package.json`, "utf8"));

  async function manifestAccepts(args: string[]): Promise<boolean> {
    const proc = Bun.spawn(["node", ".github/scripts/release-manifest.mjs", ...args, "--check"], {
      cwd: `${import.meta.dir}/../..`,
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  }

  test("the two version lines have diverged, so the check can tell them apart", () => {
    expect(pkg.version).not.toBe(pkg.keshaEngine.version);
  });

  test("a stable tag naming the engine version is accepted", async () => {
    expect(await manifestAccepts([`--tag`, `v${pkg.keshaEngine.version}`])).toBe(true);
  });

  test("a tag naming the CLI version is rejected — the engine never releases under it", async () => {
    expect(await manifestAccepts([`--tag`, `v${pkg.version}`])).toBe(false);
  });

  // Reverting the default *and* the assertion makes `v<cliVersion>` exit 0 again (grok).
  test("with no tag it defaults to the engine version rather than the CLI's", async () => {
    const proc = Bun.spawn(["node", ".github/scripts/release-manifest.mjs"], {
      cwd: `${import.meta.dir}/../..`,
      stdout: "pipe",
      stderr: "ignore",
    });
    const manifest = JSON.parse(await new Response(proc.stdout).text());

    expect(await proc.exited).toBe(0);
    expect(manifest.tag).toBe(`v${pkg.keshaEngine.version}`);
  });
});

describe("cliPublishTarget", () => {
  test("a CLI marker tag publishes the version the tag names", () => {
    expect(cliPublishTarget("v1.26.0-cli")).toEqual({ version: "1.26.0", engineOnly: false });
  });

  test("a CLI alpha keeps its prerelease identifier", () => {
    expect(cliPublishTarget("v1.27.0-alpha.1-cli")).toEqual({
      version: "1.27.0-alpha.1",
      engineOnly: false,
    });
  });

  test("an engine prerelease publishes no CLI", () => {
    for (const tag of ["v1.24.8-alpha.1", "v1.24.8-beta.1"]) {
      expect(cliPublishTarget(tag).engineOnly).toBe(true);
    }
  });

  test("a stable tag still publishes the CLI, as it does today", () => {
    expect(cliPublishTarget("v1.24.8")).toEqual({ version: "1.24.8", engineOnly: false });
  });
});
