import { readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  forbidLinuxPackaging,
  requireBashOnWindowsRunSteps,
  requireDarwinSmokeCoversBothEngines,
  requireNpmPublishAfterPackaging,
  requirePactVerificationCoversEveryTarget,
  requirePreUploadSynthesisSmoke,
  requireTestedScriptsInCodeFilter,
} from "../../.github/scripts/check-workflows";
import { parseRepoYaml, readRepoFile, repoPath } from "../helpers/repo";

const PATH = ".github/workflows/build-engine.yml";
const CI = ".github/workflows/ci.yml";
const RELEASE_CLI = ".github/workflows/release-cli.yml";
const PACT = ".github/workflows/capability-pact.yml";

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

describe("requireDarwinSmokeCoversBothEngines", () => {
  const DARWIN = "darwin-synthesis-smoke";
  const KOKORO = { name: "kokoro", run: 'bun .github/scripts/smoke-synthesis.ts --no-roundtrip --text "Kesha speaks." out' };
  const AVSPEECH = {
    name: "avspeech",
    if: "${{ !cancelled() }}",
    run: "bun .github/scripts/smoke-synthesis.ts --no-roundtrip --voice macos-en-US av",
  };

  test("passes on the real build-engine.yml", () => {
    expect(requireDarwinSmokeCoversBothEngines(PATH, parseRepoYaml(PATH))).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(requireDarwinSmokeCoversBothEngines(CI, job(DARWIN, [KOKORO]))).toEqual([]);
  });

  test("fails when only Kokoro is exercised", () => {
    const errors = requireDarwinSmokeCoversBothEngines(PATH, job(DARWIN, [KOKORO]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("macos-*");
  });

  // The Kokoro arm is the one #742 shrank; losing it would leave darwin CoreML unexercised.
  test("fails when only AVSpeech is exercised", () => {
    const errors = requireDarwinSmokeCoversBothEngines(PATH, job(DARWIN, [AVSPEECH]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Kokoro");
  });

  test("fails when an arm is switched off rather than deleted", () => {
    const errors = requireDarwinSmokeCoversBothEngines(PATH, job(DARWIN, [KOKORO, { ...AVSPEECH, if: "false" }]));
    expect(errors[0]).toContain("macos-*");
  });

  test("passes when both arms run", () => {
    expect(requireDarwinSmokeCoversBothEngines(PATH, job(DARWIN, [KOKORO, AVSPEECH]))).toEqual([]);
  });

  // AVSpeech is the only arm carrying the full pangram, and `--text` shrinks it back silently.
  test("fails when the AVSpeech arm overrides the sentence", () => {
    const shortened = { ...AVSPEECH, run: `${AVSPEECH.run} --text "Kesha speaks."` };
    const errors = requireDarwinSmokeCoversBothEngines(PATH, job(DARWIN, [KOKORO, shortened]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("--text");
  });

  test("fails when the AVSpeech arm stops running after a red Kokoro arm", () => {
    const { if: _guard, ...unguarded } = AVSPEECH;
    const errors = requireDarwinSmokeCoversBothEngines(PATH, job(DARWIN, [KOKORO, unguarded]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("!cancelled()");
  });

  test("fails when the lane is gone", () => {
    const errors = requireDarwinSmokeCoversBothEngines(PATH, { jobs: { build: {} } });
    expect(errors[0]).toContain(`expected a \`${DARWIN}\` job`);
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

describe("requirePactVerificationCoversEveryTarget", () => {
  const matrix = (targets: string[]) => ({
    jobs: { pact: { strategy: { matrix: { include: targets.map((target) => ({ os: "ubuntu-latest", target })) } } } },
  });

  test("passes on the real capability-pact.yml", () => {
    expect(requirePactVerificationCoversEveryTarget(PACT, parseRepoYaml(PACT))).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(requirePactVerificationCoversEveryTarget(CI, matrix([]))).toEqual([]);
  });

  test("fails when a published target has no runner", () => {
    const errors = requirePactVerificationCoversEveryTarget(PACT, matrix(["darwin-arm64"]));
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("no runner verifies linux-x64's pact");
  });

  test("fails when the matrix is gone", () => {
    expect(requirePactVerificationCoversEveryTarget(PACT, { jobs: { pact: {} } })[0]).toContain(
      "strategy.matrix.include",
    );
  });
});

describe("requireBashOnWindowsRunSteps", () => {
  const BARE = { name: "report", run: 'echo "target=$TARGET"' };
  const smoke = (job: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
    ...top,
    jobs: { smoke: { "runs-on": "windows-latest", steps: [BARE], ...job } },
  });
  const errorsFor = (document: unknown) => requireBashOnWindowsRunSteps(CI, document);

  test("passes on every workflow in the repo", () => {
    for (const file of readdirSync(repoPath(".github/workflows"))) {
      const path = `.github/workflows/${file}`;
      expect([path, requireBashOnWindowsRunSteps(path, parseRepoYaml(path))]).toEqual([path, []]);
    }
  });

  test("fails when a windows job leaves a run step on the default shell", () => {
    const errors = errorsFor(smoke({}));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`smoke` step `report` runs on windows without `shell:`");
  });

  test("names an unnamed step by position", () => {
    expect(errorsFor(smoke({ steps: [{ run: "ls" }] }))[0]).toContain("step 1");
  });

  test("passes when the step sets shell: bash", () => {
    expect(errorsFor(smoke({ steps: [{ ...BARE, shell: "bash" }] }))).toEqual([]);
  });

  // An explicit non-bash shell is a decision; the trap this closes is the implicit pwsh default.
  test("passes when the step opts into pwsh explicitly", () => {
    expect(errorsFor(smoke({ steps: [{ name: "report", run: "Write-Host $env:TARGET", shell: "pwsh" }] }))).toEqual([]);
  });

  test("passes when the job defaults every run step to bash", () => {
    expect(errorsFor(smoke({ defaults: { run: { shell: "bash" } } }))).toEqual([]);
  });

  test("passes when the workflow defaults every run step to bash", () => {
    expect(errorsFor(smoke({}, { defaults: { run: { shell: "bash" } } }))).toEqual([]);
  });

  test("passes when the step carries the pwsh-ok marker", () => {
    const run = "# pwsh-ok: this one really is PowerShell\nWrite-Host $env:TARGET";
    expect(errorsFor(smoke({ steps: [{ name: "report", run }] }))).toEqual([]);
  });

  test("ignores steps that only `uses` an action", () => {
    expect(errorsFor(smoke({ steps: [{ uses: "actions/checkout@3d3c42e" }] }))).toEqual([]);
  });

  test("passes when the job never touches windows", () => {
    expect(errorsFor({ jobs: { smoke: { "runs-on": "ubuntu-latest", steps: [BARE] } } })).toEqual([]);
  });

  test("fails when a self-hosted label set names windows", () => {
    expect(errorsFor(smoke({ "runs-on": ["self-hosted", "windows", "x64"] }))).toHaveLength(1);
  });

  const matrixJob = (matrix: unknown, runsOn = "${{ matrix.os }}") =>
    smoke({ "runs-on": runsOn, strategy: { matrix } });

  test("fails when a matrix list puts the job on windows", () => {
    expect(errorsFor(matrixJob({ os: ["ubuntu-latest", "windows-latest"] }))).toHaveLength(1);
  });

  test("fails when a matrix include row puts the job on windows", () => {
    const matrix = { include: [{ os: "ubuntu-latest" }, { os: "windows-latest", target: "win32-x64" }] };
    expect(errorsFor(matrixJob(matrix))).toHaveLength(1);
  });

  // A cross-compile target naming windows does not move the job off its Linux runner.
  test("resolves the key runs-on actually names", () => {
    const matrix = { os: ["ubuntu-latest"], target: ["x86_64-pc-windows-gnu"] };
    expect(errorsFor(matrixJob(matrix))).toEqual([]);
  });

  test("a matrix it cannot resolve is not treated as windows", () => {
    expect(errorsFor(matrixJob({ os: "${{ fromJSON(needs.plan.outputs.os) }}" }))).toEqual([]);
  });
});
