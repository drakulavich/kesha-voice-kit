import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SCRIPT = ".github/scripts/release-install-smoke.sh";

// The gate under test is a bash script that only ever runs on the Ubuntu release runner,
// and these cases execute its real jq rather than a reimplementation. Windows runners ship
// no jq, so there the filter cases have nothing to run — the structural assertion below
// still runs everywhere and is the one that catches the regression this file exists for.
const JQ = Bun.which("jq");

/** The jq the script actually runs, lifted from the script so the test cannot drift from it. */
function metadataFilter(): string {
  const source = readFileSync(SCRIPT, "utf8");
  const match = source.match(/jq -e --arg version "\$VERSION" '\n([\s\S]*?)\n\s*' "\$metadata"/);
  const filter = match?.[1];
  if (!filter) throw new Error(`${SCRIPT}: could not find the npm metadata jq filter`);
  return filter;
}

async function runFilter(document: unknown): Promise<boolean> {
  const proc = Bun.spawn(["jq", "-e", "--arg", "version", "1.29.1", metadataFilter()], {
    stdin: new TextEncoder().encode(JSON.stringify(document)),
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
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
  test.skipIf(!JQ)("accepts a genuinely published, provenance-carrying version", async () => {
    expect(await runFilter(PUBLISHED)).toBe(true);
  });

  test.skipIf(!JQ)("rejects the flattened shape `npm view --json <fields>` returns", async () => {
    // Asking for a field list answers with keys named
    // literally "dist.integrity" / "dist.attestations", so the nested filter reads null
    // and the gate fails every release regardless of what was published.
    const flattened = {
      version: "1.29.1",
      "dist.integrity": PUBLISHED.dist.integrity,
      "dist.attestations": PUBLISHED.dist.attestations,
    };
    expect(await runFilter(flattened)).toBe(false);
  });

  test("the script therefore requests the whole document, not a field list", () => {
    const source = readFileSync(SCRIPT, "utf8");
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
