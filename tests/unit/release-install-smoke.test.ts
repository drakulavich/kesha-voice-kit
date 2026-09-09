import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseRepoYaml, readRepoFile } from "../helpers/repo";

const WORKFLOW = ".github/workflows/release-install-smoke.yml";
const SCRIPT = ".github/scripts/release-install-smoke.sh";

// These cases run the script's real jq, which a contributor machine may not have.
const JQ = Bun.which("jq");

/** Windows checks the tree out with CRLF and the pattern below anchors on newlines. */
function readScript(): string {
  return readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
}

/** The jq the script actually runs, lifted from it so the test cannot drift from the lane. */
function metadataFilter(): string {
  const match = readScript().match(/jq -e --arg version "\$VERSION" '\n([\s\S]*?)\n\s*' "\$metadata"/);
  const filter = match?.[1];
  if (!filter) throw new Error(`${SCRIPT}: could not find the npm metadata jq filter`);
  return filter;
}

async function runFilterRaw(input: string): Promise<number> {
  const proc = Bun.spawn(["jq", "-e", "--arg", "version", "1.29.1", metadataFilter()], {
    stdin: new TextEncoder().encode(input),
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited;
}

async function runFilter(document: unknown): Promise<boolean> {
  return (await runFilterRaw(JSON.stringify(document))) === 0;
}

/** What `npm view <pkg> --json` returns, trimmed to the keys the filter reads. */
const PUBLISHED = {
  version: "1.29.1",
  dist: {
    integrity: "sha512-avT1buNeu0R2AsD0eaN1FCs5wlerjWET7jAlmBcGhnksILSmDOWjKJkAQe1wvkEkGkn/rhGop3ieB9QuCPRmPA==",
    attestations: {
      url: "https://registry.npmjs.org/-/npm/v1/attestations/@drakulavich%2fkesha-voice-kit@1.29.1",
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    },
  },
};

describe("release install smoke", () => {
  test("keeps the draft gate manual and makes the post-npm path reusable", () => {
    const workflow = parseRepoYaml(WORKFLOW);

    expect(workflow.on.workflow_dispatch.inputs.mode.default).toBe("draft-engine");
    expect(workflow.on.workflow_call.inputs.version.required).toBe(true);
    expect(workflow.on.workflow_call.inputs.mode.default).toBe("npm");
    expect(workflow.jobs["draft-engine"].permissions).toEqual({ contents: "write" });
    expect(workflow.jobs.npm.permissions).toEqual({ contents: "read" });
  });

  test("downloads the authenticated draft artifact into a disposable private cache", () => {
    const script = readRepoFile(SCRIPT);
    const synthesisSmoke = readRepoFile(".github/scripts/smoke-synthesis.ts");

    expect(script).toContain('gh release download "$TAG"');
    expect(script).toContain('[ "$(gh release view "$TAG" --json isDraft --jq .isDraft)" = "true" ]');
    expect(script).toContain('KESHA_ENGINE_BIN="$assets/$asset"');
    expect(script).toContain('KESHA_CACHE_DIR="$scratch/cache"');
    expect(script).toContain('bun "$repo_root/.github/scripts/assert-install-warmup.ts"');
    expect(script).toContain('bun "$repo_root/.github/scripts/smoke-synthesis.ts"');
    expect(script).toContain('trap cleanup EXIT');
    expect(synthesisSmoke).toContain('process.env.KESHA_COMMAND || "kesha"');
  });

  test("installs an exact npm package and requires provenance metadata", () => {
    const script = readRepoFile(SCRIPT);

    expect(script).toContain('npm view "$package@$VERSION" --json > "$metadata"');
    expect(script).toContain('https://slsa.dev/provenance/v1');
    expect(script).toContain('npm install --global "$package@$VERSION"');
    expect(script).toContain('NPM_CONFIG_PREFIX="$prefix"');
    expect(script).toContain('installed npm package version was $installed_version, expected $VERSION');
  });

  test("runs the npm smoke only after the release lane has observed the published version", () => {
    const cliRelease = parseRepoYaml(".github/workflows/release-cli.yml");
    const job = cliRelease.jobs["published-install-smoke"];

    expect(job.needs).toEqual(["plan", "publish-npm"]);
    expect(job.uses).toBe("./.github/workflows/release-install-smoke.yml");
    expect(job.with).toEqual({
      tag: "${{ needs.plan.outputs.tag }}",
      version: "${{ needs.plan.outputs.version }}",
    });
  });
});

describe("release-install-smoke npm metadata gate", () => {
  test("jq is present in CI, so none of the cases below are silently skipped", () => {
    if (process.env.CI) expect(JQ).toBeTruthy();
  });

  test.skipIf(!JQ)("accepts a genuinely published, provenance-carrying version", async () => {
    expect(await runFilter(PUBLISHED)).toBe(true);
  });

  // The regression: `--json version,dist.integrity,dist.attestations` is one comma-joined
  // argument, and npm answers it with zero bytes at exit 0 — not an empty object, which
  // would exit 1 rather than 4.
  test.skipIf(!JQ)("fails on the nothing-at-all the comma-joined field list returns", async () => {
    expect(await runFilterRaw("")).toBe(4);
  });

  // The other way a field list breaks this filter, and the one easily mistaken for the regression above.
  test.skipIf(!JQ)("rejects the flattened shape a space-separated field list returns", async () => {
    const flattened = {
      version: "1.29.1",
      "dist.integrity": PUBLISHED.dist.integrity,
      "dist.attestations": PUBLISHED.dist.attestations,
    };
    expect(await runFilter(flattened)).toBe(false);
  });

  test("the script therefore requests the whole document, not a field list", () => {
    expect(readScript()).toContain(`npm view "$package@$VERSION" --json > "$metadata"`);
  });

  test.skipIf(!JQ)("rejects a version published without provenance", async () => {
    const noProvenance = { ...PUBLISHED, dist: { ...PUBLISHED.dist, attestations: undefined } };
    expect(await runFilter(noProvenance)).toBe(false);
  });

  test.skipIf(!JQ)("rejects a provenance predicate that is not SLSA v1", async () => {
    const wrongPredicate = {
      ...PUBLISHED,
      dist: { ...PUBLISHED.dist, attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v0.2" } } },
    };
    expect(await runFilter(wrongPredicate)).toBe(false);
  });

  test.skipIf(!JQ)("rejects a mismatched version even when everything else is present", async () => {
    expect(await runFilter({ ...PUBLISHED, version: "1.29.0" })).toBe(false);
  });

  test.skipIf(!JQ)("rejects an integrity digest that is not sha512", async () => {
    const weakDigest = { ...PUBLISHED, dist: { ...PUBLISHED.dist, integrity: "sha1-deadbeef" } };
    expect(await runFilter(weakDigest)).toBe(false);
  });
});
