import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  cliPublishTarget,
  ENGINE_TAG_ERE,
  ENGINE_TAG_RE,
  expectedTagVersion,
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

describe("expectedTagVersion", () => {
  const pkg = { cliVersion: "1.27.0", engineVersion: "1.24.7" };

  test("a stable tag answers to the CLI version, which names the Linux packages", () => {
    expect(expectedTagVersion("v1.27.0", pkg)).toEqual({
      field: "package.json#version",
      version: "1.27.0",
    });
  });

  test("a prerelease answers to the engine version the manifest describes", () => {
    for (const tag of ["v1.24.7-alpha.1", "v1.24.7-beta.1"]) {
      expect(expectedTagVersion(tag, pkg)).toEqual({
        field: "package.json#keshaEngine.version",
        version: "1.24.7",
      });
    }
  });

  test("an engine alpha whose version line carries the suffix matches", () => {
    const alpha = { cliVersion: "1.27.0", engineVersion: "1.24.8-alpha.1" };

    expect(expectedTagVersion("v1.24.8-alpha.1", alpha).version).toBe("1.24.8-alpha.1");
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
