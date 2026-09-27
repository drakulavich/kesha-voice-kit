import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_TAG_RE, isEngineAlphaTag, isStableTag } from "../../.github/scripts/release-tags.mjs";
import { parseRepoYaml, readRepoFile, REPO_ROOT } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";

const RELEASE = parseRepoYaml(".github/workflows/release.yml");

const TAGS = ["v1.24.8", "v1.24.8-beta.1", "v1.24.8-alpha.1"];
const CLI_TAGS = ["v1.27.0-cli", "v1.27.0-alpha.1-cli"];
const NOT_TAGS = ["1.24.8", "v1.24", "v1.24.8-alpha", "v1.24.8-alpha.x", "v1.24.8; id"];

describe("release tag grammar", () => {
  test("accepts stable, beta and alpha tags", () => {
    for (const tag of TAGS) expect(ENGINE_TAG_RE.test(tag)).toBe(true);
  });

  test("rejects retired CLI marker tags and malformed shapes", () => {
    for (const tag of [...CLI_TAGS, ...NOT_TAGS]) expect(ENGINE_TAG_RE.test(tag)).toBe(false);
  });

  test("only a bare version is stable", () => {
    expect(isStableTag("v1.24.8")).toBe(true);
    for (const tag of ["v1.24.8-beta.1", "v1.24.8-alpha.1", "v1.27.0-cli", "V1.24.8", "v1.24.8+build", ...NOT_TAGS]) {
      expect(isStableTag(tag)).toBe(false);
    }
  });
});

// An alpha tag is written by the run that published it; a push of one must not start a second run.
describe("release trigger", () => {
  test("a pushed version tag starts a release, an alpha tag does not", () => {
    expect(RELEASE.on.push.tags).toEqual(["v*", "!v*-alpha.*"]);
  });
});

describe("alpha shape", () => {
  test("only an alpha shape counts as one", () => {
    expect(isEngineAlphaTag("v1.24.8-alpha.1")).toBe(true);
    for (const tag of ["v1.24.8", "v1.24.8-beta.1", "v1.27.0-alpha.1-cli", "v1.24.8-alpha"]) {
      expect(isEngineAlphaTag(tag)).toBe(false);
    }
  });
});

// Driven through the script because that assertion is the gate the release runs (#696).
describe("release manifest tag check", () => {
  const SCRIPT = `${REPO_ROOT}/.github/scripts/release-manifest.mjs`;
  const pkg = JSON.parse(readRepoFile("package.json"));

  // Assert the message, not just a non-zero exit: an unrelated crash must not read as rejection.
  async function manifestCheck(args: string[], cwd = REPO_ROOT) {
    const proc = Bun.spawn(["node", SCRIPT, ...args, "--check"], {
      cwd,
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    return { accepted: (await proc.exited) === 0, stderr };
  }

  // validateSourceConsistency reads src/, .github/ and packaging/ from cwd, so link the real ones in.
  const fixtures: string[] = [];
  const LINKED = ["src", ".github", "packaging"];

  function fixtureRepo(version: string): string {
    const dir = tempDir("kesha-manifest-");
    for (const entry of LINKED) symlinkSync(`${REPO_ROOT}/${entry}`, join(dir, entry));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
    fixtures.push(dir);
    return dir;
  }

  afterAll(() => {
    // Unlink by name rather than rm -r: never let cleanup walk into the linked repo dirs.
    for (const dir of fixtures) {
      for (const entry of [...LINKED, "package.json"]) unlinkSync(join(dir, entry));
      rmdirSync(dir);
    }
  });

  test("a stable tag naming the repository's one version is accepted", async () => {
    expect((await manifestCheck(["--tag", `v${pkg.version}`])).accepted).toBe(true);
  });

  test("a stable tag naming another version is rejected, naming the committed one", async () => {
    const cwd = fixtureRepo("1.32.0");
    const { accepted, stderr } = await manifestCheck(["--tag", "v1.33.0"], cwd);

    expect(accepted).toBe(false);
    expect(stderr).toContain("must name package.json#version (1.32.0)");
  });

  // release.yml derives alphas and accepts betas as prereleases of the committed version (D3).
  test.each(["v1.32.0-alpha.1", "v1.32.0-beta.2"])("%s, a prerelease of the committed version, is accepted", async (tag) => {
    expect((await manifestCheck(["--tag", tag], fixtureRepo("1.32.0"))).accepted).toBe(true);
  });

  test.each(["v1.31.0-alpha.1", "v1.33.0-beta.1", "v1.32.1-alpha.1"])("%s, a prerelease of another version, is rejected", async (tag) => {
    const { accepted, stderr } = await manifestCheck(["--tag", tag], fixtureRepo("1.32.0"));

    expect(accepted).toBe(false);
    expect(stderr).toContain("or a prerelease of it");
  });

  test("the manifest describes the prerelease it publishes", async () => {
    const proc = Bun.spawn(["node", SCRIPT, "--tag", "v1.32.0-alpha.1"], {
      cwd: fixtureRepo("1.32.0"),
      stdout: "pipe",
      stderr: "ignore",
    });
    const manifest = JSON.parse(await new Response(proc.stdout).text());

    expect(manifest.tag).toBe("v1.32.0-alpha.1");
    expect(manifest.engineVersion).toBe("1.32.0-alpha.1");
  });

  // Reverting the default *and* the assertion makes `v<cliVersion>` exit 0 again (grok).
  test("with no tag it defaults to the committed version", async () => {
    const proc = Bun.spawn(["node", SCRIPT], { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" });
    const manifest = JSON.parse(await new Response(proc.stdout).text());

    expect(await proc.exited).toBe(0);
    expect(manifest.tag).toBe(`v${pkg.version}`);
  });
});

// npm's trusted publisher is keyed to one *entry* workflow name and a package configures
// exactly one, so any lane that publishes from a second workflow gets an opaque 404 from the
// registry — which is why the alpha lane never published at all between #700 and #732.
describe("one publish entry", () => {
  const code = (path: string) =>
    readRepoFile(path)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

  test("no workflow but release.yml runs npm publish", () => {
    const publishers = readdirSync(join(REPO_ROOT, ".github/workflows")).filter(
      (file) => /\.ya?ml$/.test(file) && code(`.github/workflows/${file}`).includes("npm publish"),
    );
    expect(publishers).toEqual(["release.yml"]);
  });

  test("the alpha tag is reserved by release.yml before npm publishes it", () => {
    const reserve = RELEASE.jobs["reserve-tag"];
    expect(reserve.steps.some((s: { run?: string }) => s.run === ".github/scripts/alpha-tag.sh")).toBe(true);
    expect(RELEASE.jobs["npm-publish"].needs).toContain("reserve-tag");
  });
});

describe("release manifest source consistency", () => {
  // Only release.yml, as after the cutover: the check must still hold it to every asset the manifest names.
  test("a release.yml that no longer builds a manifest asset fails, naming both", () => {
    const dir = tempDir("kesha-manifest-release-");
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    for (const entry of ["src", "packaging", "package.json"]) symlinkSync(`${REPO_ROOT}/${entry}`, join(dir, entry));
    symlinkSync(`${REPO_ROOT}/.github/scripts`, join(dir, ".github", "scripts"));
    const workflow = readRepoFile(".github/workflows/release.yml").replaceAll("kesha-textlang-darwin-arm64", "gone");
    writeFileSync(join(dir, ".github", "workflows", "release.yml"), workflow);

    const run = Bun.spawnSync(["node", `${REPO_ROOT}/.github/scripts/release-manifest.mjs`, "--check"], { cwd: dir });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain(".github/workflows/release.yml is missing release manifest token: kesha-textlang-darwin-arm64");
    for (const entry of ["src", "packaging", "package.json", ".github/scripts"]) unlinkSync(join(dir, entry));
  });
});

describe("release manifest Linux packages", () => {
  const manifestFor = (...args: string[]) => {
    const run = Bun.spawnSync(["node", `${REPO_ROOT}/.github/scripts/release-manifest.mjs`, ...args], { cwd: REPO_ROOT });
    expect(run.exitCode).toBe(0);
    return JSON.parse(run.stdout.toString()) as { assets: Array<{ name: string; kind: string; checksummed: boolean }> };
  };
  const tag = `v${JSON.parse(readRepoFile("package.json")).version}`;

  test("a stable release with packages names the .deb and .rpm of its own version, checksummed", () => {
    const version = tag.slice(1);
    const packages = manifestFor("--tag", tag, "--linux-packages").assets.filter((a) => a.kind === "linux-package");
    expect(packages.map((a) => a.name).sort()).toEqual([
      `kesha-voice-kit-${version}-1.x86_64.rpm`,
      `kesha-voice-kit_${version}-1_amd64.deb`,
    ]);
    expect(packages.every((a) => a.checksummed)).toBe(true);
  });

  test("without the flag the manifest names no package", () => {
    expect(manifestFor("--tag", tag).assets.some((a) => a.kind === "linux-package")).toBe(false);
  });
});
