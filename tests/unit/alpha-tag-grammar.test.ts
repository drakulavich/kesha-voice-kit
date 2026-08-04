import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/build-engine.yml";
const REPO_ROOT = `${import.meta.dir}/../..`;

const CLI_STABLE = "v1.27.0-cli";
const CLI_ALPHA = "v1.27.0-alpha.1-cli";
const ENGINE_STABLE = "v1.24.8";
const ENGINE_BETA = "v1.24.8-beta.1";
const ENGINE_ALPHA = "v1.24.8-alpha.1";

/** The bash pattern the workflow actually ships, not a copy of it. */
function engineTagPattern(): string {
  const yaml = readFileSync(`${REPO_ROOT}/${WORKFLOW}`, "utf8");
  const match = yaml.match(/INPUT_TAG"\s*=~\s*(\^v\S+\$)\s*\]\]/);
  if (!match) throw new Error("could not find the tag-shape regex in build-engine.yml");
  return match[1];
}

async function bashAccepts(pattern: string, tag: string): Promise<boolean> {
  const proc = Bun.spawn(["bash", "-c", `[[ "$1" =~ ${pattern} ]]`, "bash", tag], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

async function runManifest(tag: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(
    ["node", ".github/scripts/release-manifest.mjs", "--tag", tag, "--check"],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

describe("engine tag-shape validator", () => {
  test("accepts stable, beta and alpha engine tags", async () => {
    const pattern = engineTagPattern();
    for (const tag of [ENGINE_STABLE, ENGINE_BETA, ENGINE_ALPHA]) {
      expect(await bashAccepts(pattern, tag)).toBe(true);
    }
  });

  test("rejects CLI marker tags, including alpha ones", async () => {
    const pattern = engineTagPattern();
    for (const tag of [CLI_STABLE, CLI_ALPHA]) {
      expect(await bashAccepts(pattern, tag)).toBe(false);
    }
  });

  test("rejects shapes that are not tags at all", async () => {
    const pattern = engineTagPattern();
    for (const tag of ["1.24.8", "v1.24", "v1.24.8-alpha", "v1.24.8-alpha.x", "v1.24.8; id"]) {
      expect(await bashAccepts(pattern, tag)).toBe(false);
    }
  });
});

describe("engine build trigger", () => {
  test("a CLI marker tag is excluded from the push filter", () => {
    const tags = parse(readFileSync(`${REPO_ROOT}/${WORKFLOW}`, "utf8")).on.push.tags;

    expect(tags).toContain("v*");
    expect(tags).toContain("!v*-cli");
    // #685: the CLI alpha grammar ends in -cli precisely so this exclusion covers it.
    expect(CLI_ALPHA.endsWith("-cli")).toBe(true);
  });
});

describe("release manifest tag validator", () => {
  test("rejects a CLI marker tag", async () => {
    const { code, stderr } = await runManifest(CLI_ALPHA);
    expect(code).not.toBe(0);
    expect(stderr).toContain("must look like");
  });

  test("rejects an engine tag whose version is not the installed engine version", async () => {
    const { code, stderr } = await runManifest("v9.9.9-alpha.1");
    expect(code).not.toBe(0);
    expect(stderr).toContain("keshaEngine.version");
  });

  test("a well-formed alpha clears the shape check and is judged on its version", async () => {
    const { stderr } = await runManifest("v9.9.9-alpha.1");

    expect(stderr).not.toContain("must look like");
  });

  test("still rejects a malformed alpha on shape", async () => {
    for (const tag of ["v9.9.9-alpha", "v9.9.9-alpha.x"]) {
      const { code, stderr } = await runManifest(tag);
      expect(code).not.toBe(0);
      expect(stderr).toContain("must look like");
    }
  });
});
