import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { requirePreUploadSynthesisSmoke } from "../../.github/scripts/check-workflows";

const PATH = ".github/workflows/build-engine.yml";

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
