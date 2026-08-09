import { describe, expect, test } from "bun:test";
import {
  forbidLinuxPackaging,
  requireNpmPublishAfterPackaging,
  requirePreUploadSynthesisSmoke,
  requireTestedScriptsInCodeFilter,
} from "../../.github/scripts/check-workflows";
import { parseRepoYaml, readRepoFile } from "../helpers/repo";

const PATH = ".github/workflows/build-engine.yml";
const CI = ".github/workflows/ci.yml";
const RELEASE_CLI = ".github/workflows/release-cli.yml";

function job(name: string, steps: unknown[]) {
  return { jobs: { [name]: { steps } } };
}

const SMOKE = { name: "smoke", run: "bun .github/scripts/smoke-synthesis.ts --no-roundtrip out" };
const UPLOAD = { name: "upload", uses: "actions/upload-artifact@043fb46" };

describe("requirePreUploadSynthesisSmoke", () => {
  test("passes on the real build-engine.yml", () => {
    expect(requirePreUploadSynthesisSmoke(PATH, parseRepoYaml(PATH))).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(requirePreUploadSynthesisSmoke(".github/workflows/ci.yml", job("build", [UPLOAD]))).toEqual([]);
  });

  test("fails when the synthesis smoke is deleted", () => {
    const errors = requirePreUploadSynthesisSmoke(PATH, job("build", [UPLOAD]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must run smoke-synthesis.ts before uploading");
  });

  test("fails when the smoke runs after the upload", () => {
    const errors = requirePreUploadSynthesisSmoke(PATH, job("build", [UPLOAD, SMOKE]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("runs after the artifact is uploaded");
  });

  test("passes when the smoke precedes the upload", () => {
    expect(requirePreUploadSynthesisSmoke(PATH, job("build", [SMOKE, UPLOAD]))).toEqual([]);
  });

  test("fails when the smoke step is disabled", () => {
    const errors = requirePreUploadSynthesisSmoke(PATH, job("build", [{ ...SMOKE, if: "false" }, UPLOAD]));
    expect(errors[0]).toContain("must run smoke-synthesis.ts");
  });

  test("fails when the invocation is only mentioned, not run", () => {
    for (const run of ["# bun .github/scripts/smoke-synthesis.ts out", 'echo "smoke-synthesis.ts"']) {
      const errors = requirePreUploadSynthesisSmoke(PATH, job("build", [{ name: "x", run }, UPLOAD]));
      expect(errors[0]).toContain("must run smoke-synthesis.ts");
    }
  });

  test("accepts a platform-restricted smoke step", () => {
    const step = { ...SMOKE, if: "matrix.os != 'macos-14'" };
    expect(requirePreUploadSynthesisSmoke(PATH, job("build", [step, UPLOAD]))).toEqual([]);
  });

  test("fails when nothing uploads the artifact", () => {
    const errors = requirePreUploadSynthesisSmoke(PATH, job("build", [SMOKE]));
    expect(errors[0]).toContain("must upload the engine artifact");
  });

  test("fails when the build job is gone", () => {
    const errors = requirePreUploadSynthesisSmoke(PATH, { jobs: { release: {} } });
    expect(errors[0]).toContain("expected a `build` job");
  });
});

describe("forbidLinuxPackaging", () => {
  test("passes on the real build-engine.yml", () => {
    expect(forbidLinuxPackaging(PATH, readRepoFile(PATH))).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(forbidLinuxPackaging(CI, "run: node .github/scripts/build-linux-packages.mjs")).toEqual([]);
  });

  test.each([
    "        run: node .github/scripts/build-linux-packages.mjs",
    "        run: cp dist/linux-packages/*.{deb,rpm} release-assets/",
    "        run: nfpm package -p deb -t release-assets/",
    "        run: cp dist/*.deb release-assets/",
    "        run: go install github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.43.4",
  ])("catches %s", (line) => {
    expect(forbidLinuxPackaging(PATH, line).length).toBeGreaterThan(0);
  });

  test("prose about the policy is not packaging", () => {
    const comment = "      # packages (.deb/.rpm) moved off engine tags; see nfpm notes in #728";
    expect(forbidLinuxPackaging(PATH, comment)).toEqual([]);
  });
});

describe("requireNpmPublishAfterPackaging", () => {
  const DISPATCH = { name: "dispatch", run: ".github/scripts/dispatch-npm-publish.sh" };
  const PACKAGING = [
    { name: "build", uses: "./.github/actions/linux-packages" },
    { name: "publish", run: ".github/scripts/publish-cli-release.sh" },
  ];
  const lane = (publishNpm: unknown, packages: unknown[] = PACKAGING) => ({
    on: { push: { tags: ["v*-cli"] } },
    jobs: { packages: { steps: packages }, "publish-npm": publishNpm },
  });
  const withNpm = (packages: unknown[]) => lane({ needs: ["packages"], steps: [DISPATCH] }, packages);

  test("passes on the real release-cli.yml", () => {
    expect(requireNpmPublishAfterPackaging(RELEASE_CLI, parseRepoYaml(RELEASE_CLI))).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(requireNpmPublishAfterPackaging(PATH, { jobs: {} })).toEqual([]);
  });

  const NPM = { needs: ["packages"], steps: [DISPATCH] };
  const firstError = (document: unknown) =>
    requireNpmPublishAfterPackaging(RELEASE_CLI, document)[0] ?? "";

  const broken: [string, unknown, string][] = [
    ["the tag filter would take in engine tags", { ...lane(NPM), on: { push: { tags: ["v*"] } } }, "must trigger on `v*-cli`"],
    // `needs: packages` on a packages job that builds nothing satisfies the ordering and ships nothing (grok).
    ["the packaging job builds nothing", withNpm([PACKAGING[1]]), "must build through ./.github/actions/linux-packages"],
    ["the packaging job publishes nothing", withNpm([PACKAGING[0]]), "must run publish-cli-release.sh"],
    ["the packaging job is gone", { on: { push: { tags: ["v*-cli"] } }, jobs: { "publish-npm": NPM } }, "expected a `packages` job"],
    // Dropping the dependency lets a .deb reach users for a version npm never served (#728).
    ["the npm publish no longer waits for the packaging job", lane({ ...NPM, needs: ["plan"] }), "must `needs: packages`"],
    ["nothing dispatches npm-publish.yml", lane({ needs: ["plan", "packages"], steps: [] }), "must run dispatch-npm-publish.sh"],
    ["the publish job is gone", { on: { push: { tags: ["v*-cli"] } }, jobs: { packages: { steps: PACKAGING } } }, "expected a `publish-npm` job"],
  ];

  test.each(broken)("fails when %s", (_name, document, expected) => {
    expect(firstError(document)).toContain(expected);
  });

  test("accepts the single-job spelling of needs", () => {
    expect(requireNpmPublishAfterPackaging(RELEASE_CLI, lane({ ...NPM, needs: "packages" }))).toEqual([]);
  });
});

const codeFilter = (paths: string[]) =>
  job("changes", [{ with: { filters: `code:\n${paths.map((p) => `  - '${p}'`).join("\n")}\n` } }]);

describe("requireTestedScriptsInCodeFilter", () => {
  test("passes on the real ci.yml", () => {
    const document = parseRepoYaml(CI);
    expect(requireTestedScriptsInCodeFilter(CI, document, [".github/scripts/check-versions.ts"])).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(requireTestedScriptsInCodeFilter(PATH, codeFilter([]), [".github/scripts/check-versions.ts"])).toEqual([]);
  });

  test("fails when a tested script sits outside the filter", () => {
    const errors = requireTestedScriptsInCodeFilter(CI, codeFilter(["src/**"]), [".github/scripts/check-versions.ts"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("check-versions.ts has a unit test but no matching path");
  });

  test("a directory wildcard covers the scripts under it", () => {
    const document = codeFilter([".github/scripts/**"]);
    expect(requireTestedScriptsInCodeFilter(CI, document, [".github/scripts/alpha-tag.sh"])).toEqual([]);
  });

  // An exact path covers only itself, so listing one script silently leaves its neighbours unguarded.
  test("an exact path covers only that script", () => {
    const document = codeFilter([".github/scripts/smoke-synthesis.ts"]);
    const scripts = [".github/scripts/smoke-synthesis.ts", ".github/scripts/check-versions.ts"];
    const errors = requireTestedScriptsInCodeFilter(CI, document, scripts);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("check-versions.ts");
  });

  test("fails when the code list is gone", () => {
    const document = job("changes", [{ with: { filters: "integration:\n  - 'src/**'\n" } }]);
    expect(requireTestedScriptsInCodeFilter(CI, document, [])[0]).toContain("missing a `code` list");
  });

  test("fails when the changes job has no inline filters", () => {
    expect(requireTestedScriptsInCodeFilter(CI, { jobs: { changes: {} } }, [])[0]).toContain("expected a `changes` job");
  });
});
