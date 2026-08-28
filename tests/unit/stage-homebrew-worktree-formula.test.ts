import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rewriteFormula } from "../../.github/scripts/stage-homebrew-worktree-formula.mjs";
import { readRepoFile } from "../helpers/repo";

const FORMULA = readRepoFile("packaging/homebrew/Formula/kesha-voice-kit.rb");
const VERSION = JSON.parse(readRepoFile("package.json")).version;

const archive = Buffer.from("a throwaway git-archive of HEAD");
const SHA256 = createHash("sha256").update(archive).digest("hex");
const URL = "file:///tmp/kesha-worktree.tar.gz";

describe("rewriteFormula", () => {
  test("points url at the file:// archive and drops the release tag", () => {
    const out = rewriteFormula(FORMULA, { url: URL, version: VERSION, sha256: SHA256 });

    expect(out).toContain(`url "${URL}"`);
    expect(out).not.toContain("archive/refs/tags");
  });

  test("pins sha256 to the staged archive", () => {
    const out = rewriteFormula(FORMULA, { url: URL, version: VERSION, sha256: SHA256 });

    expect(out).toContain(`sha256 "${SHA256}"`);
  });

  test("pins version to package.json so the formula's --version test can match", () => {
    const out = rewriteFormula(FORMULA, { url: URL, version: VERSION, sha256: SHA256 });

    expect(out).toContain(`version "${VERSION}"`);
  });

  test("replaces an existing version line rather than duplicating it", () => {
    const withVersion = rewriteFormula(FORMULA, { url: URL, version: "1.29.1", sha256: SHA256 });
    const out = rewriteFormula(withVersion, { url: URL, version: "1.30.0", sha256: SHA256 });

    expect(out.match(/^  version /gm)).toHaveLength(1);
    expect(out).toContain('version "1.30.0"');
    expect(out).not.toContain('version "1.29.1"');
  });

  test("omits the version line, and strips any existing one, when version is falsy", () => {
    const withVersion = rewriteFormula(FORMULA, { url: URL, version: "1.24.7", sha256: SHA256 });
    const out = rewriteFormula(withVersion, { url: URL, version: null, sha256: SHA256 });

    expect(out).not.toMatch(/^  version /m);
  });

  // The CLI writes the tap formula only with rewriteFormula's return value, so a
  // formula it rejects can never leave a partial file behind.
  test("refuses a formula with no url before returning a rewrite", () => {
    const noUrl = FORMULA.replace(/^  url ".*"$/m, "  # url removed");

    expect(() => rewriteFormula(noUrl, { url: URL, version: VERSION, sha256: SHA256 })).toThrow(
      /missing url/,
    );
  });

  test("refuses a formula with no sha256 before returning a rewrite", () => {
    const noSha = FORMULA.replace(/^  sha256 "[a-f0-9]{64}"$/m, "  # sha256 removed");

    expect(() => rewriteFormula(noSha, { url: URL, version: VERSION, sha256: SHA256 })).toThrow(
      /missing sha256/,
    );
  });
});
