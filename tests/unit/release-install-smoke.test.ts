import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SCRIPT = ".github/scripts/release-install-smoke.sh";

// These cases execute the script's real jq rather than a reimplementation, so they need it
// on PATH. GitHub runners all ship it; a contributor machine may not.
const JQ = Bun.which("jq");

/** The jq the script actually runs, lifted from the script so the test cannot drift from it. */
function metadataFilter(): string {
  // Windows CI checks the tree out with CRLF, and the pattern below anchors on newlines:
  // without this the filter is simply not found and every case fails on that runner alone.
  const source = readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
  const match = source.match(/jq -e --arg version "\$VERSION" '\n([\s\S]*?)\n\s*' "\$metadata"/);
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

describe("release-install-smoke npm metadata gate", () => {
  // The skip is an escape hatch for contributor machines, not for CI. Without this a future
  // image change could silently skip every predicate case and leave the suite green.
  test("jq is present in CI, so none of the cases below are silently skipped", () => {
    if (process.env.CI) expect(JQ).toBeTruthy();
  });

  test.skipIf(!JQ)("accepts a genuinely published, provenance-carrying version", async () => {
    expect(await runFilter(PUBLISHED)).toBe(true);
  });

  // THE regression. The replaced command was `--json version,dist.integrity,dist.attestations`
  // — one comma-joined argument, not three. npm answers that with an empty document at exit 0,
  // and `jq -e` on no input exits 4, so the gate failed every release whatever was published.
  test.skipIf(!JQ)("fails on the empty document the comma-joined field list produced", async () => {
    expect(await runFilterRaw("")).toBe(4);
  });

  // Not the regression: the space-separated form flattens instead of emptying. Kept because it
  // is the other way a field list breaks this filter, and the difference is easy to misread —
  // the first analysis of this bug reproduced this shape and described it as the cause.
  test.skipIf(!JQ)("rejects the flattened shape a space-separated field list returns", async () => {
    const flattened = {
      version: "1.29.1",
      "dist.integrity": PUBLISHED.dist.integrity,
      "dist.attestations": PUBLISHED.dist.attestations,
    };
    expect(await runFilter(flattened)).toBe(false);
  });

  test("the script therefore requests the whole document, not a field list", () => {
    const source = readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
    expect(source).toContain(`npm view "$package@$VERSION" --json > "$metadata"`);
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
