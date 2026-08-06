import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  requireNpmPublishedGate,
  requirePreUploadSynthesisSmoke,
  requireTestedScriptsInCodeFilter,
} from "../../.github/scripts/check-workflows";

const PATH = ".github/workflows/build-engine.yml";
const CI = ".github/workflows/ci.yml";

function buildJob(steps: unknown[]) {
  return { jobs: { build: { steps } } };
}

const SMOKE = { name: "smoke", run: "bun .github/scripts/smoke-synthesis.ts --no-roundtrip out" };
const UPLOAD = { name: "upload", uses: "actions/upload-artifact@043fb46" };

describe("requirePreUploadSynthesisSmoke", () => {
  test("passes on the real build-engine.yml", () => {
    expect(requirePreUploadSynthesisSmoke(PATH, parse(readFileSync(PATH, "utf8")))).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(requirePreUploadSynthesisSmoke(".github/workflows/ci.yml", buildJob([UPLOAD]))).toEqual([]);
  });

  test("fails when the synthesis smoke is deleted", () => {
    const errors = requirePreUploadSynthesisSmoke(PATH, buildJob([UPLOAD]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must run smoke-synthesis.ts before uploading");
  });

  test("fails when the smoke runs after the upload", () => {
    const errors = requirePreUploadSynthesisSmoke(PATH, buildJob([UPLOAD, SMOKE]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("runs after the artifact is uploaded");
  });

  test("passes when the smoke precedes the upload", () => {
    expect(requirePreUploadSynthesisSmoke(PATH, buildJob([SMOKE, UPLOAD]))).toEqual([]);
  });

  test("fails when the smoke step is disabled", () => {
    const errors = requirePreUploadSynthesisSmoke(PATH, buildJob([{ ...SMOKE, if: "false" }, UPLOAD]));
    expect(errors[0]).toContain("must run smoke-synthesis.ts");
  });

  test("fails when the invocation is only mentioned, not run", () => {
    for (const run of ["# bun .github/scripts/smoke-synthesis.ts out", 'echo "smoke-synthesis.ts"']) {
      const errors = requirePreUploadSynthesisSmoke(PATH, buildJob([{ name: "x", run }, UPLOAD]));
      expect(errors[0]).toContain("must run smoke-synthesis.ts");
    }
  });

  test("accepts a platform-restricted smoke step", () => {
    const step = { ...SMOKE, if: "matrix.os != 'macos-14'" };
    expect(requirePreUploadSynthesisSmoke(PATH, buildJob([step, UPLOAD]))).toEqual([]);
  });

  test("fails when nothing uploads the artifact", () => {
    const errors = requirePreUploadSynthesisSmoke(PATH, buildJob([SMOKE]));
    expect(errors[0]).toContain("must upload the engine artifact");
  });

  test("fails when the build job is gone", () => {
    const errors = requirePreUploadSynthesisSmoke(PATH, { jobs: { release: {} } });
    expect(errors[0]).toContain("expected a `build` job");
  });
});

const STABLE = "steps.release_kind.outputs.prerelease != 'true'";
const GATE = { name: "gate", if: STABLE, run: "node .github/scripts/assert-npm-published.mjs" };
const BUILD_PKG = { name: "build", if: STABLE, run: "node .github/scripts/build-linux-packages.mjs" };
const STAGE_PKG = { name: "stage", if: STABLE, run: "cp dist/linux-packages/*.{deb,rpm} release-assets/" };

function releaseJob(steps: unknown[]) {
  return { jobs: { release: { steps } } };
}

describe("requireNpmPublishedGate", () => {
  test("passes on the real build-engine.yml", () => {
    expect(requireNpmPublishedGate(PATH, parse(readFileSync(PATH, "utf8")))).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(requireNpmPublishedGate(CI, releaseJob([BUILD_PKG]))).toEqual([]);
  });

  test("passes when the gate precedes both packaging steps", () => {
    expect(requireNpmPublishedGate(PATH, releaseJob([GATE, BUILD_PKG, STAGE_PKG]))).toEqual([]);
  });

  test("fails when the gate is deleted", () => {
    const errors = requireNpmPublishedGate(PATH, releaseJob([BUILD_PKG, STAGE_PKG]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must run assert-npm-published.mjs before naming a Linux package");
  });

  test("fails when the gate is only mentioned, not run", () => {
    for (const run of ["# node .github/scripts/assert-npm-published.mjs", 'echo "assert-npm-published.mjs"']) {
      const errors = requireNpmPublishedGate(PATH, releaseJob([{ name: "x", if: STABLE, run }, BUILD_PKG]));
      expect(errors[0]).toContain("must run assert-npm-published.mjs");
    }
  });

  test("fails when the gate step is disabled", () => {
    const errors = requireNpmPublishedGate(PATH, releaseJob([{ ...GATE, if: "false" }, BUILD_PKG]));
    expect(errors[0]).toContain("must run assert-npm-published.mjs");
  });

  test("fails when the gate runs after a packaging step", () => {
    const errors = requireNpmPublishedGate(PATH, releaseJob([BUILD_PKG, GATE, STAGE_PKG]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("runs after step 1 packages Linux artifacts");
  });

  // A packaging step on a wider condition runs on releases the gate sits out.
  test("fails when a packaging step carries a different condition", () => {
    const errors = requireNpmPublishedGate(PATH, releaseJob([GATE, BUILD_PKG, { ...STAGE_PKG, if: undefined }]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("step 3 packages Linux artifacts under a different `if`");
  });

  test("fails when the release job is gone", () => {
    expect(requireNpmPublishedGate(PATH, { jobs: { build: {} } })[0]).toContain("expected a `release` job");
  });

  test("fails when nothing packages the Linux artifacts", () => {
    expect(requireNpmPublishedGate(PATH, releaseJob([GATE]))[0]).toContain("build and stage the Linux packages");
  });
});

function filterJob(code: string[]) {
  return { jobs: { changes: { steps: [{ with: { filters: `code:\n${code.map((p) => `  - '${p}'`).join("\n")}\n` } }] } } };
}

describe("requireTestedScriptsInCodeFilter", () => {
  test("passes on the real ci.yml", () => {
    const document = parse(readFileSync(CI, "utf8"));
    expect(requireTestedScriptsInCodeFilter(CI, document, [".github/scripts/check-versions.ts"])).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(requireTestedScriptsInCodeFilter(PATH, filterJob([]), [".github/scripts/check-versions.ts"])).toEqual([]);
  });

  test("fails when a tested script sits outside the filter", () => {
    const errors = requireTestedScriptsInCodeFilter(CI, filterJob(["src/**"]), [".github/scripts/check-versions.ts"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("check-versions.ts has a unit test but no matching path");
  });

  test("a directory wildcard covers the scripts under it", () => {
    const document = filterJob([".github/scripts/**"]);
    expect(requireTestedScriptsInCodeFilter(CI, document, [".github/scripts/alpha-tag.sh"])).toEqual([]);
  });

  // An exact path covers only itself, so listing one script silently leaves its neighbours unguarded.
  test("an exact path covers only that script", () => {
    const document = filterJob([".github/scripts/smoke-synthesis.ts"]);
    const scripts = [".github/scripts/smoke-synthesis.ts", ".github/scripts/check-versions.ts"];
    const errors = requireTestedScriptsInCodeFilter(CI, document, scripts);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("check-versions.ts");
  });

  test("fails when the code list is gone", () => {
    const document = { jobs: { changes: { steps: [{ with: { filters: "integration:\n  - 'src/**'\n" } }] } } };
    expect(requireTestedScriptsInCodeFilter(CI, document, [])[0]).toContain("missing a `code` list");
  });

  test("fails when the changes job has no inline filters", () => {
    expect(requireTestedScriptsInCodeFilter(CI, { jobs: { changes: {} } }, [])[0]).toContain("expected a `changes` job");
  });
});
