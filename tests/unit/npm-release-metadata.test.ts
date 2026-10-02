import { describe, expect, test } from "bun:test";
import { assertNpmReleaseMetadata, viewWhenPublished } from "../../.github/scripts/npm-release-metadata";

const PACKAGE = "@drakulavich/kesha-voice-kit";

// The shape `npm view <pkg>@<version> --json` prints for one published version, as npm 11 renders it.
function published(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: PACKAGE,
    version: "1.30.0",
    dist: {
      integrity: "sha512-+BOOflA1t8wmGLF4I+YhUFaBUyvQQm7pH90UIS/P6RxcEOSemP8oaRIuQDL7IoFrRWKawdGYltX5NfDIfXxCfw==",
      attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/@drakulavich%2fkesha-voice-kit@1.30.0", provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
    },
    ...overrides,
  });
}

describe("npm release metadata gate", () => {
  test("accepts a published version carrying integrity and SLSA v1 provenance", () => {
    expect(assertNpmReleaseMetadata(published(), PACKAGE, "1.30.0", 0)).toEqual({ version: "1.30.0", provenance: "https://slsa.dev/provenance/v1" });
  });

  test("an empty answer — what a malformed field list makes npm print — names the package, never passes", () => {
    expect(() => assertNpmReleaseMetadata("", PACKAGE, "1.30.0", 0)).toThrow(/@drakulavich\/kesha-voice-kit@1\.30\.0.*no JSON/);
  });

  test("a version other than the one asked for is refused by name", () => {
    expect(() => assertNpmReleaseMetadata(published({ version: "1.29.1" }), PACKAGE, "1.30.0", 0)).toThrow(/version 1\.29\.1, expected 1\.30\.0/);
  });

  test("a publish without provenance is refused, naming what is missing", () => {
    const noProvenance = published({ dist: { integrity: "sha512-abc" } });
    expect(() => assertNpmReleaseMetadata(noProvenance, PACKAGE, "1.30.0", 0)).toThrow(/provenance/);
  });

  test("a registry query that exited non-zero is refused even when its stdout looks right (Greptile P2)", () => {
    expect(() => assertNpmReleaseMetadata(published(), PACKAGE, "1.30.0", 1)).toThrow(/npm view exited 1/);
  });

  test("an integrity that is not sha512 is refused", () => {
    const weak = published({ dist: { integrity: "sha1-abc", attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } });
    expect(() => assertNpmReleaseMetadata(weak, PACKAGE, "1.30.0", 0)).toThrow(/integrity/);
  });
});

describe("waiting for a fresh publish to reach the registry (#1356)", () => {
  const notYet = { stdout: "", exitCode: 1 };

  test("a version that 404s for a while and then appears passes the gate", async () => {
    const answers = [notYet, notYet, { stdout: published(), exitCode: 0 }];
    const view = await viewWhenPublished(() => answers.shift() ?? notYet, PACKAGE, "1.30.0", 5, 0);
    expect(assertNpmReleaseMetadata(view.stdout, PACKAGE, "1.30.0", view.exitCode)).toEqual({ version: "1.30.0", provenance: "https://slsa.dev/provenance/v1" });
  });

  test("a version served before its provenance is attached is waited for, not failed (Greptile P1)", async () => {
    const unattested = { stdout: published({ dist: { integrity: "sha512-abc" } }), exitCode: 0 };
    const answers = [unattested, { stdout: published(), exitCode: 0 }];
    const view = await viewWhenPublished(() => answers.shift() ?? unattested, PACKAGE, "1.30.0", 5, 0);
    expect(assertNpmReleaseMetadata(view.stdout, PACKAGE, "1.30.0", view.exitCode).provenance).toBe("https://slsa.dev/provenance/v1");
  });

  test("a version that never appears still fails the gate", async () => {
    const view = await viewWhenPublished(() => notYet, PACKAGE, "1.30.0", 3, 0);
    expect(() => assertNpmReleaseMetadata(view.stdout, PACKAGE, "1.30.0", view.exitCode)).toThrow(/npm view exited 1/);
  });
});
