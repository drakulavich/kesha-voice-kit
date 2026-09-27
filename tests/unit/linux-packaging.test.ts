import { describe, expect, test } from "bun:test";
import { readRepoFile } from "../helpers/repo";

// release.yml's `packages` job attaches the pair to a stable release; linux-packages.yml builds and
// smoke-installs it on main, and its path filter means an unrelated PR never exercises it — so the
// invariants need a home that always runs.
const PACKAGE_SCRIPT = ".github/scripts/build-linux-packages.mjs";
const PACKAGE_NAMES = ".github/scripts/linux-package-names.mjs";
const NFPM_CONFIG = "packaging/nfpm.yaml";
const COMPOSITE = ".github/actions/linux-packages/action.yml";

describe("linux packaging pipeline", () => {
  test.each([
    [PACKAGE_SCRIPT, "--target=bun-linux-x64"],
    [PACKAGE_SCRIPT, "packaging/nfpm.yaml"],
    [PACKAGE_SCRIPT, "LINUX_PACKAGE_RELEASE"],
    [PACKAGE_NAMES, "LINUX_PACKAGE_RELEASE"],
    [NFPM_CONFIG, "dst: /usr/bin/kesha"],
    [COMPOSITE, "build-linux-packages.mjs"],
    [COMPOSITE, "verify-linux-packages.sh"],
  ])("%s carries %s", (path, token) => {
    expect(readRepoFile(path)).toContain(token);
  });

  // One composite so the CI lane and the release lane cannot build the pair differently.
  test.each([".github/workflows/linux-packages.yml", ".github/workflows/release.yml"])(
    "%s builds through the shared composite",
    (workflow) => {
      expect(readRepoFile(workflow)).toContain("./.github/actions/linux-packages");
    },
  );
});
