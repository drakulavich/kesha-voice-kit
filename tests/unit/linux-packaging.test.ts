import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// These lived in release-manifest.mjs while the manifest promised .deb/.rpm assets. Engine
// releases no longer attach them (#728), but linux-packages.yml still builds and smoke-installs
// the pair on main, and its path filter means an unrelated PR never exercises it — so the
// invariants need a home that always runs.
const PACKAGE_SCRIPT = ".github/scripts/build-linux-packages.mjs";
const PACKAGE_NAMES = ".github/scripts/linux-package-names.mjs";
const NFPM_CONFIG = "packaging/nfpm.yaml";

const read = (path: string) => readFileSync(path, "utf8");

describe("linux packaging pipeline", () => {
  test.each([
    [PACKAGE_SCRIPT, "--target=bun-linux-x64"],
    [PACKAGE_SCRIPT, "packaging/nfpm.yaml"],
    [PACKAGE_SCRIPT, "LINUX_PACKAGE_RELEASE"],
    [PACKAGE_NAMES, "LINUX_PACKAGE_RELEASE"],
    [NFPM_CONFIG, "dst: /usr/bin/kesha"],
  ])("%s carries %s", (path, token) => {
    expect(read(path)).toContain(token);
  });

  test("the packages are built by linux-packages.yml, not by an engine release", () => {
    expect(read(".github/workflows/linux-packages.yml")).toContain("build-linux-packages.mjs");
    expect(read(".github/workflows/build-engine.yml")).not.toContain("build-linux-packages.mjs");
  });
});
