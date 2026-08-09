import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyReleaseTag } from "../../.github/scripts/classify-release-tag.mjs";
import {
  CLI_TAG_RE,
  cliPublishTarget,
  ENGINE_TAG_ERE,
  ENGINE_TAG_RE,
  isEngineAlphaTag,
} from "../../.github/scripts/release-tags.mjs";
import { parseRepoYaml, readRepoFile, REPO_ROOT } from "../helpers/repo";

const WORKFLOW = ".github/workflows/build-engine.yml";
const WORKFLOW_YAML = readRepoFile(WORKFLOW);
const BUILD_ENGINE = parseRepoYaml(WORKFLOW);

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

// Built from the same version pattern as the engine grammar, so the two cannot drift apart.
describe("CLI marker tag grammar", () => {
  test("accepts every CLI shape", () => {
    for (const tag of [...CLI_TAGS, "v1.27.0-beta.1-cli"]) {
      expect(CLI_TAG_RE.test(tag)).toBe(true);
    }
  });

  test("rejects engine tags and malformed shapes", () => {
    for (const tag of [...ENGINE_TAGS, ...NOT_TAGS, "v1.27.0-cli-cli", "v1.27.0-rc.1-cli", "cli"]) {
      expect(CLI_TAG_RE.test(tag)).toBe(false);
    }
  });
});

describe("engine build trigger", () => {
  test("CLI marker tags are excluded from the push filter", () => {
    expect(BUILD_ENGINE.on.push.tags).toEqual(["v*", "!v*-cli"]);
  });
});

describe("engine alpha publication", () => {
  const steps = BUILD_ENGINE.jobs.release.steps;
  const releaseStep = steps.find((s: { uses?: string }) => s.uses?.startsWith("softprops/"));
  const buildSteps = BUILD_ENGINE.jobs.build.steps;

  test("only an engine alpha shape counts as one", () => {
    expect(isEngineAlphaTag("v1.24.8-alpha.1")).toBe(true);
    for (const tag of ["v1.24.8", "v1.24.8-beta.1", "v1.27.0-alpha.1-cli", "v1.24.8-alpha"]) {
      expect(isEngineAlphaTag(tag)).toBe(false);
    }
  });

  // An alpha behind the un-draft gate is not installable, which is the whole point of one (#685).
  test("only an alpha publishes itself, and only stable is not a prerelease", () => {
    expect(classifyReleaseTag("v1.24.8-alpha.1")).toEqual({ publish: true, prerelease: true });
    expect(classifyReleaseTag("v1.24.8")).toEqual({ publish: false, prerelease: false });
    expect(classifyReleaseTag("v1.24.8-beta.1")).toEqual({ publish: false, prerelease: true });
  });

  // Releases here are immutable: an asset uploaded after publication fails with a 422.
  test("assets are always uploaded to a draft", () => {
    expect(releaseStep.with.draft).toBe(true);
    expect(releaseStep.with.prerelease).toBe("${{ steps.release_kind.outputs.prerelease }}");
  });

  test("the alpha is un-drafted afterwards, by the classifier's verdict", () => {
    const publishStep = steps.find((s: { name?: string }) => s.name === "Publish the alpha");

    expect(steps.indexOf(publishStep)).toBeGreaterThan(steps.indexOf(releaseStep));
    expect(publishStep.if).toBe("steps.release_kind.outputs.publish == 'true'");
    expect(publishStep.run).toContain("--draft=false");
    expect(publishStep.run).not.toContain("${{");
    expect(publishStep.env.TAG_NAME).toBe("${{ github.ref_name }}");
  });

  test("the build applies the alpha version, and only for a tag that names one", () => {
    const inject = buildSteps.find((s: { name?: string }) => s.name === "Apply the alpha engine version");

    expect(inject.run).toContain("set-cargo-version.mjs");
    expect(inject.if).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(inject.if).toContain("contains(github.ref_name, '-alpha.')");
    // The tag reaches the shell as a variable; `$(…)` in a ref must not execute (#291).
    expect(inject.run).not.toContain("${{");
    expect(inject.env.TAG_NAME).toBe("${{ github.ref_name }}");
  });
});

// Driven through the script because that assertion is the gate build-engine.yml runs (#696).
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

  function fixtureRepo(version: string, engineVersion: string): string {
    const dir = mkdtempSync(join(tmpdir(), "kesha-manifest-"));
    for (const entry of LINKED) symlinkSync(`${REPO_ROOT}/${entry}`, join(dir, entry));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ version, keshaEngine: { version: engineVersion } }),
    );
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

  test("a stable tag naming the engine version is accepted", async () => {
    expect((await manifestCheck(["--tag", `v${pkg.keshaEngine.version}`])).accepted).toBe(true);
  });

  test("a tag naming the CLI version is rejected — the engine never releases under it", async () => {
    const cwd = fixtureRepo("9.9.9", "1.24.8");
    const { accepted, stderr } = await manifestCheck(["--tag", "v9.9.9"], cwd);

    expect(accepted).toBe(false);
    expect(stderr).toContain("must match package.json#keshaEngine.version (1.24.8)");
  });

  // Lockstep is legal (check-versions.ts rule 2 is `cli >= engine`), so divergence is not an invariant.
  test("a release where both lines carry the same version still validates", async () => {
    const cwd = fixtureRepo("1.24.8", "1.24.8");
    expect((await manifestCheck(["--tag", "v1.24.8"], cwd)).accepted).toBe(true);
  });

  test("an engine alpha is accepted when the version line carries the suffix too", async () => {
    const cwd = fixtureRepo("1.27.0", "1.24.8-alpha.1");
    expect((await manifestCheck(["--tag", "v1.24.8-alpha.1"], cwd)).accepted).toBe(true);
  });

  // The pin names the released engine and may never name an alpha (#738), so an alpha leads it.
  test("an engine alpha above the pin is accepted", async () => {
    const cwd = fixtureRepo("1.27.0", "1.24.7");
    expect((await manifestCheck(["--tag", "v1.24.8-alpha.1"], cwd)).accepted).toBe(true);
  });

  test("an engine alpha below the pin is rejected", async () => {
    const cwd = fixtureRepo("1.27.0", "1.24.9");
    const { accepted, stderr } = await manifestCheck(["--tag", "v1.24.8-alpha.1"], cwd);

    expect(accepted).toBe(false);
    expect(stderr).toContain("or name an alpha above it");
  });

  // Only alphas may lead the pin; a stable or beta tag ahead of it means the bump was forgotten.
  test("a stable or beta tag above the pin is still rejected", async () => {
    const cwd = fixtureRepo("1.27.0", "1.24.7");

    expect((await manifestCheck(["--tag", "v1.24.8"], cwd)).accepted).toBe(false);
    expect((await manifestCheck(["--tag", "v1.24.8-beta.1"], cwd)).accepted).toBe(false);
  });

  test("the manifest describes the alpha, not the pin it leads", async () => {
    const cwd = fixtureRepo("1.27.0", "1.24.7");
    const proc = Bun.spawn(["node", SCRIPT, "--tag", "v1.24.8-alpha.1"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const manifest = JSON.parse(await new Response(proc.stdout).text());

    expect(manifest.tag).toBe("v1.24.8-alpha.1");
    expect(manifest.engineVersion).toBe("1.24.8-alpha.1");
  });

  test("the base version of an alpha is not an alias for it, in either direction", async () => {
    const alpha = fixtureRepo("1.27.0", "1.24.8-alpha.1");
    expect((await manifestCheck(["--tag", "v1.24.8"], alpha)).accepted).toBe(false);

    // Stripping -alpha.N before compare would publish an alpha tag as the stable release.
    const stable = fixtureRepo("1.27.0", "1.24.8");
    expect((await manifestCheck(["--tag", "v1.24.8-alpha.1"], stable)).accepted).toBe(false);
  });

  // Reverting the default *and* the assertion makes `v<cliVersion>` exit 0 again (grok).
  test("with no tag it defaults to the engine version rather than the CLI's", async () => {
    const proc = Bun.spawn(["node", SCRIPT], { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" });
    const manifest = JSON.parse(await new Response(proc.stdout).text());

    expect(await proc.exited).toBe(0);
    expect(manifest.tag).toBe(`v${pkg.keshaEngine.version}`);
  });
});

describe("cliPublishTarget", () => {
  test("a CLI marker tag publishes the version the tag names", () => {
    expect(cliPublishTarget("v1.26.0-cli")).toEqual({
      version: "1.26.0",
      engineOnly: false,
      derived: false,
    });
  });

  test("a CLI alpha keeps its prerelease identifier", () => {
    expect(cliPublishTarget("v1.27.0-alpha.1-cli")).toEqual({
      version: "1.27.0-alpha.1",
      engineOnly: false,
      derived: true,
    });
  });

  // A bare tag names the engine version, so publishing it would put main's unreleased CLI
  // on npm under the engine's number and move `latest` backwards (#729).
  test("no engine tag publishes a CLI, stable included", () => {
    for (const tag of ["v1.24.8", "v1.24.8-alpha.1", "v1.24.8-beta.1"]) {
      expect(cliPublishTarget(tag).engineOnly).toBe(true);
    }
  });

  test("the CLI ships only from its own marker tag", () => {
    for (const tag of ["v1.26.0-cli", "v1.27.0-alpha.1-cli"]) {
      expect(cliPublishTarget(tag).engineOnly).toBe(false);
    }
  });
});

// npm's trusted publisher is keyed to one entry workflow name, so an alpha that publishes
// from its own workflow gets an opaque 404 from the registry (#731).
describe("alpha publish entry", () => {
  const alpha = ".github/workflows/release-alpha.yml";

  test("the alpha workflow holds no OIDC credential", () => {
    expect(readRepoFile(alpha)).not.toContain("id-token");
  });

  test("it publishes by dispatching npm-publish.yml", () => {
    expect(readRepoFile(".github/scripts/dispatch-npm-publish.sh")).toContain("WORKFLOW=npm-publish.yml");
    expect(parseRepoYaml(alpha).jobs.publish.steps.at(-1).run).toContain("dispatch-npm-publish.sh");
  });

  test("npm-publish injects the version for tags no commit carries", () => {
    const publish = parseRepoYaml(".github/workflows/npm-publish.yml").jobs.publish;

    expect(publish.with["inject-version"]).toContain("derived");
  });
});

describe("publish serialisation and provenance", () => {
  const script = readRepoFile(".github/scripts/dispatch-npm-publish.sh");

  // Without --ref the run's head_sha is main's tip, so provenance attests a commit whose
  // tree is not what shipped; it is also what makes the run findable by tag.
  test("the dispatch pins the run to the tag being published", () => {
    expect(script).toContain('--ref "$TAG"');
    expect(script).toContain('--branch "$TAG"');
  });

  test("an unidentifiable run fails rather than watching whatever is newest", () => {
    expect(script).toContain('[ -z "$run" ]');
  });

  test("publishes are serialised so a late one cannot move a dist-tag backwards", () => {
    const publish = parseRepoYaml(".github/workflows/npm-publish.yml");

    expect(publish.concurrency).toEqual({ group: "npm-publish", queue: "max" });
  });
});
