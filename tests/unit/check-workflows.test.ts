import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  checkFile,
  checkFlakeNix,
  collectCacheWriters,
  collectManifestSources,
  collectRustSources,
  collectRuleSources,
  forbidFindPipedToHead,
  forbidLinuxPackaging,
  forbidNixBuildInCiAggregator,
  requireJobTimeouts,
  requireBashOnWindowsRunSteps,
  requireConcurrencyOnPullRequestWorkflows,
  requireBuildEngineSerialisesRunsPerRef,
  requireReleaseVerifiesTagIsCurrent,
  requireRustTestCancelsSupersededRuns,
  requirePipefailShell,
  requireReusableCallPermissions,
  requireRestoreOnlyCachesHaveAWriter,
  requireDarwinSmokeCoversBothEngines,
  requireDepsBeforeBunTest,
  requireFlakeNixInWorkflowsFilter,
  requireManifestSourcesInCodeFilter,
  requireRustSourcesInCodeFilter,
  requireManifestSourcesInSeedFilter,
  requireNpmPublishAfterPackaging,
  requirePactVerificationCoversEveryTarget,
  requirePinnedRustToolchain,
  requirePreUploadSynthesisSmoke,
  readRustToolchainPin,
  requireTestedScriptsInCodeFilter,
} from "../../.github/scripts/check-workflows";
import { parseRepoYaml, readRepoFile, repoPath, REPO_ROOT } from "../helpers/repo";

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

describe("forbidFindPipedToHead", () => {
  test("passes on every workflow in the repo", () => {
    for (const file of readdirSync(repoPath(".github/workflows"))) {
      const path = `.github/workflows/${file}`;
      expect([path, forbidFindPipedToHead(path, readRepoFile(path))]).toEqual([path, []]);
    }
  });

  test("ignores every other file", () => {
    expect(forbidFindPipedToHead(CI, 'run: echo "no find here"')).toEqual([]);
  });

  test.each([
    'sidecar=$(find "rust/target/x/release/build" -name say-avspeech -type f | head -1)',
    "path=$(find . -name '*.so' | head -n1)",
    "path=$(find . -name '*.so' | head -n 1)",
  ])("catches %s", (line) => {
    const errors = forbidFindPipedToHead(PATH, `          ${line}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("SIGPIPE");
    expect(errors[0]).toContain("#1088");
  });

  test("names the 1-indexed line number", () => {
    const contents = "line one\nline two\nsidecar=$(find . -name x | head -1)\n";
    const errors = forbidFindPipedToHead(PATH, contents);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${PATH}:3:`);
  });

  test("catches a backslash-continued pipeline split across two lines", () => {
    const contents = "sidecar=$(find . -name x \\\n  | head -1)\n";
    const errors = forbidFindPipedToHead(PATH, contents);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${PATH}:1:`);
  });

  test("a continuation that never resolves to find|head is not flagged", () => {
    const contents = "sidecar=$(find . -name x \\\n  -type f)\n";
    expect(forbidFindPipedToHead(PATH, contents)).toEqual([]);
  });

  test("accepts the -print -quit replacement", () => {
    const line = '          sidecar=$(find "rust/target/x/release/build" -name say-avspeech -type f -print -quit)';
    expect(forbidFindPipedToHead(PATH, line)).toEqual([]);
  });

  test("prose about the pattern in a comment is not a pipeline", () => {
    const comment = "      # avoid piping find into head, see #1088";
    expect(forbidFindPipedToHead(PATH, comment)).toEqual([]);
  });

  test("a commented-out find|head line is not flagged", () => {
    const line = "      # sidecar=$(find . -name x | head -1)";
    expect(forbidFindPipedToHead(PATH, line)).toEqual([]);
  });

  test("a trailing comment after a real find|head command does not hide it", () => {
    const line = "      sidecar=$(find . -name x | head -1)  # stage it";
    expect(forbidFindPipedToHead(PATH, line)).toHaveLength(1);
  });

  // A dropped check wouldn't show up against the clean repo tree, only against a probe (see above).
  test("the file gate actually runs it", () => {
    const yaml = "on: push\njobs:\n  smoke:\n    runs-on: macos-14\n    steps:\n      - run: find . -name x | head -1\n";
    const path = join(mkdtempSync(join(tmpdir(), "kesha-wf-")), "probe.yml");
    writeFileSync(path, yaml);
    expect(checkFile(path, [], [], undefined, NO_SOURCES).filter((e) => e.includes("#1088"))).toHaveLength(1);
  });
});

describe("checkFlakeNix", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "kesha-flake-"));

  test("catches find piped to head", () => {
    const path = join(dir(), "flake.nix");
    writeFileSync(path, "sidecar=$(find . -path '*/out/say-avspeech' -type f | head -1)\n");
    expect(checkFlakeNix(path)).toHaveLength(1);
  });

  test("accepts the -print -quit replacement", () => {
    const path = join(dir(), "flake.nix");
    writeFileSync(path, "sidecar=$(find . -path '*/out/say-avspeech' -type f -print -quit)\n");
    expect(checkFlakeNix(path)).toEqual([]);
  });

  test("a missing file is not an error", () => {
    expect(checkFlakeNix(join(dir(), "does-not-exist.nix"))).toEqual([]);
  });

  test("the repo's own flake.nix is clean", () => {
    expect(checkFlakeNix(repoPath("flake.nix"))).toEqual([]);
  });

  // Drives the real entry point, unlike every other test here — pins main()'s wiring, not just checkFlakeNix itself.
  test("check:workflows fails end-to-end when flake.nix reintroduces find|head", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-main-"));
    try {
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      mkdirSync(join(dir, ".github/actions"), { recursive: true });
      mkdirSync(join(dir, "tests/unit"), { recursive: true });
      writeFileSync(
        join(dir, ".github/workflows/probe.yml"),
        "on: push\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps: []\n",
      );
      writeFileSync(join(dir, "flake.nix"), "sidecar=$(find . -name x | head -1)\n");

      const proc = Bun.spawn(["bun", join(REPO_ROOT, ".github/scripts/check-workflows.ts")], {
        cwd: dir,
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();

      expect(await proc.exited).toBe(1);
      expect(stderr).toContain("flake.nix:1:");
      expect(stderr).toContain("#1088");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

const SEED = ".github/workflows/cache-seed.yml";
const seedFilter = (paths: string[]) => ({ on: { push: { paths } } });

// readdirSync/join emit win32 separators on Windows; the rules normalise at compare time, so the
// real-tree assertions have to as well or they only hold on posix (#950 round 3).
const NO_SOURCES = { manifestSources: [], rustSources: [] };

const repoRelative = (files: string[]) =>
  files.map((file) => file.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"));

describe("manifest sources stay inside both path filters", () => {
  // Both shapes defeated a cfg(test)-excluding scanner and dropped the production pin below them
  // (#950 round 3). Collecting them is the safe direction: over-inclusion only widens a path filter.
  test("a production pin below a cfg(test) use-item is collected", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-models-"));
    writeFileSync(
      join(dir, "use_item.rs"),
      '#[cfg(test)]\npub(crate) use super::helper;\npub const ASR: &[ModelFile] = &[ModelFile { rel_path: "encoder.onnx" }];\n',
    );
    expect(collectManifestSources(dir)).toEqual([join(dir, "use_item.rs")]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a production pin below a test module holding an unbalanced brace in a string is collected", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-models-"));
    writeFileSync(
      join(dir, "brace_literal.rs"),
      '#[cfg(test)]\nmod tests { #[test] fn t() { assert_eq!(render("x"), "prefix{"); } }\npub const ASR: &[ModelFile] = &[ModelFile { rel_path: "encoder.onnx" }];\n',
    );
    expect(collectManifestSources(dir)).toEqual([join(dir, "brace_literal.rs")]);
    rmSync(dir, { recursive: true, force: true });
  });

  // #950 round 2: the rust/src/** workflows-filter entry closes the guard's silent-skip gap on the very
  // PR that violates it — so the entry itself needs a pin, or its removal survives every lane.
  test("ci.yml's workflows filter carries rust/src/**, so check:workflows runs on a rust-pin PR", () => {
    const raw = readRepoFile(".github/workflows/ci.yml");
    const filters = /workflows:\n((?:\s+(?:#[^\n]*|- '[^']+')\n)+)/.exec(raw);
    expect(filters?.[1] ?? "").toContain("- 'rust/src/**'");
  });

  test("collectManifestSources finds the engine's pinned manifests and nothing else", () => {
    const sources = repoRelative(collectManifestSources(repoPath("rust/src")));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toContain("rust/src/models/manifest.rs");
  });

  // main() calls collectRuleSources() with no arguments, so narrowing the default reverts the widening silently (#1132 round 3).
  test("the production default root is rust/src, not the models tree", () => {
    expect(collectRustSources().map((file) => file.replaceAll("\\", "/"))).toContain("rust/src/text_lang.rs");
  });

  test("collectRustSources returns every .rs under rust/src", () => {
    const tree = repoRelative(collectRustSources(repoPath("rust/src")));
    expect(tree.length).toBeGreaterThanOrEqual(6);
    expect(tree).toContain("rust/src/models/paths.rs");
    expect(tree).toContain("rust/src/models/staging.rs");
    expect(tree).toContain("rust/src/text_lang.rs");
  });

  // rust-cross-references.test.ts reads all of rust/src, so a rename outside models/ must still fire unit-tests (#1132).
  test("the real ci.yml code filter covers every Rust source, not just the models tree", () => {
    const sources = repoRelative(collectRustSources(repoPath("rust/src")));
    expect(requireRustSourcesInCodeFilter(CI, parseRepoYaml(CI), sources)).toEqual([]);
  });

  test("the real ci.yml and cache-seed.yml cover every one of them", () => {
    const sources = repoRelative(collectManifestSources(repoPath("rust/src")));
    expect(requireManifestSourcesInCodeFilter(CI, parseRepoYaml(CI), sources)).toEqual([]);
    expect(requireManifestSourcesInSeedFilter(SEED, parseRepoYaml(SEED), sources)).toEqual([]);
  });

  test("ci.yml dropping the manifest path de-gates the install-plan join", () => {
    const errors = requireManifestSourcesInCodeFilter(CI, codeFilter(["src/**"]), [
      "rust/src/models.rs",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("skips the install-plan join");
  });

  test("cache-seed.yml dropping the manifest path stops the re-seed", () => {
    const errors = requireManifestSourcesInSeedFilter(SEED, seedFilter(["rust/Cargo.lock"]), [
      "rust/src/models.rs",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("never re-seeds the shared model caches");
  });

  // #950 round 2: the TS pact suites read every .rs under the models tree (paths.rs and staging.rs
  // included), so narrowing ci.ymls code filter to only the ModelFile-literal files must fail loudly —
  // documenting the hazard in a docstring was the round-1 answer, enforcing it is this rules job.
  test("narrowing the code filter to the literal-holding files fails naming the tree files it drops", () => {
    const filters = codeFilter(["rust/src/models/manifest.rs", "rust/src/models/download.rs"]);
    const tree = [
      "rust/src/models/download.rs", "rust/src/models/manifest.rs", "rust/src/models/mod.rs",
      "rust/src/models/paths.rs", "rust/src/models/progress.rs", "rust/src/models/staging.rs",
    ];
    const errors = requireRustSourcesInCodeFilter("ci.yml", filters, tree);
    expect(errors).toHaveLength(4);
    expect(errors.join("\n")).toContain("rust/src/models/paths.rs");
    expect(errors.join("\n")).toContain("rust/src/models/staging.rs");
  });

  test("the whole-directory wildcard satisfies the models-tree rule", () => {
    const filters = codeFilter(["rust/src/models/**"]);
    const tree = ["rust/src/models/paths.rs", "rust/src/models/staging.rs"];
    expect(requireRustSourcesInCodeFilter("ci.yml", filters, tree)).toHaveLength(0);
  });

  test("a directory wildcard covers the manifests under it", () => {
    const sources = ["rust/src/models/manifest.rs", "rust/src/models/mod.rs"];
    expect(requireManifestSourcesInCodeFilter(CI, codeFilter(["rust/src/models/**"]), sources)).toEqual([]);
    expect(requireManifestSourcesInSeedFilter(SEED, seedFilter(["rust/src/models/**"]), sources)).toEqual([]);
  });

  test("each rule ignores every other workflow", () => {
    expect(requireManifestSourcesInCodeFilter(SEED, seedFilter([]), ["rust/src/models.rs"])).toEqual([]);
    expect(requireManifestSourcesInSeedFilter(CI, codeFilter([]), ["rust/src/models.rs"])).toEqual([]);
  });

  // A non-wildcard filter entry is an exact path, not a prefix: paths-filter would not fire on
  // 'rust/src/models/manifest.rs' for the entry 'rust/src/models/manifest', so neither may this (#950 round 3).
  test("a filter entry that is only a substring of the file does not cover it", () => {
    const errors = requireManifestSourcesInCodeFilter(CI, codeFilter(["rust/src/models/manifest"]), [
      "rust/src/models/manifest.rs",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("contains ModelFile literals");
  });

  test("a backslash-separated source (win32's readdirSync/join output) still matches a forward-slash filter", () => {
    expect(repoRelative([`${REPO_ROOT}\\rust\\src\\models\\paths.rs`])).toEqual([
      "rust/src/models/paths.rs",
    ]);
    const sources = ["rust\\src\\models\\manifest.rs", "rust\\src\\models\\download.rs"];
    expect(requireManifestSourcesInCodeFilter(CI, codeFilter(["rust/src/models/**"]), sources)).toEqual([]);
    expect(requireManifestSourcesInSeedFilter(SEED, seedFilter(["rust/src/models/**"]), sources)).toEqual([]);
  });

  test("fails when cache-seed.yml has no push paths filter at all", () => {
    expect(requireManifestSourcesInSeedFilter(SEED, { on: { push: {} } }, [])[0]).toContain(
      "expected a `push` trigger",
    );
  });

  test("an empty rustSources list fails loudly instead of passing vacuously", () => {
    const errors = requireRustSourcesInCodeFilter(CI, codeFilter(["rust/src/models/**"]), []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("returned no files");
  });

  test("an empty manifestSources list fails loudly instead of passing vacuously", () => {
    const codeErrors = requireManifestSourcesInCodeFilter(CI, codeFilter(["rust/src/models/**"]), []);
    expect(codeErrors).toHaveLength(1);
    expect(codeErrors[0]).toContain("returned no files");

    const seedErrors = requireManifestSourcesInSeedFilter(SEED, seedFilter(["rust/src/models/**"]), []);
    expect(seedErrors).toHaveLength(1);
    expect(seedErrors[0]).toContain("returned no files");
  });

  test("main pairs each rule with its own collector", () => {
    const { manifestSources, rustSources } = collectRuleSources(
      repoPath("rust/src"), repoPath("rust/src/models"),
    );
    expect(repoRelative(rustSources)).toContain("rust/src/models/paths.rs");
    expect(repoRelative(manifestSources)).not.toContain("rust/src/models/paths.rs");
  });

  // The real tree cannot separate the two lists — both path filters are directory wildcards that cover
  // every models file — so the argument order checkFile forwards is only visible on distinct sets (#950 round 3).
  test("checkFile forwards each list to its own rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-wf-"));
    const ci = join(dir, "ci.yml");
    writeFileSync(ci, "on: push\njobs:\n  changes:\n    steps:\n      - with:\n          filters: |\n            code:\n              - 'a.rs'\n              - 'b.rs'\n");
    const seed = join(dir, "cache-seed.yml");
    writeFileSync(seed, "on:\n  push:\n    paths:\n      - 'a.rs'\n");

    const sources = { manifestSources: ["a.rs"], rustSources: ["a.rs", "b.rs"] };
    expect(checkFile(ci, [], [], undefined, sources).filter((e) => e.includes("#950"))).toEqual([]);
    expect(checkFile(seed, [], [], undefined, sources).filter((e) => e.includes("#950"))).toEqual([]);

    // Handing the seed rule the models-tree set instead names b.rs, which the push filter never covers.
    const swapped = checkFile(seed, [], [], undefined, {
      manifestSources: sources.rustSources,
      rustSources: sources.manifestSources,
    }).filter((e) => e.includes("#950"));
    expect(swapped).toHaveLength(1);
    expect(swapped[0]).toContain("b.rs");

    rmSync(dir, { recursive: true, force: true });
  });

  // A gate is only a gate if checkFile still calls it; the real tree cannot notice an unwired one.
  test("the file gate actually runs both", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-wf-"));
    const ci = join(dir, "ci.yml");
    writeFileSync(ci, "on: push\njobs:\n  changes:\n    steps:\n      - with:\n          filters: |\n            code:\n              - 'src/**'\n");
    // Distinct fifth and sixth arguments: each rule must name the file from its OWN set, so handing
    // requireRustSourcesInCodeFilter the manifest set instead of the tree set is visible here (#950 round 3).
    const errors = checkFile(ci, [], [], undefined, {
      manifestSources: ["rust/src/models/manifest.rs"],
      rustSources: ["rust/src/models/paths.rs"],
    }).filter((e) => e.includes("#950"));
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("rust/src/models/manifest.rs contains ModelFile literals");
    expect(errors.join("\n")).toContain("rust/src/models/paths.rs is read by a TS suite");

    const seed = join(dir, "cache-seed.yml");
    writeFileSync(seed, "on:\n  push:\n    paths:\n      - 'rust/Cargo.lock'\n");
    expect(
      checkFile(seed, [], [], undefined, {
        manifestSources: ["rust/src/models.rs"],
        rustSources: ["rust/src/models.rs"],
      }).filter((e) => e.includes("#950")),
    ).toHaveLength(1);
  });
});

const workflowsFilter = (paths: string[]) =>
  job("changes", [{ with: { filters: `workflows:\n${paths.map((p) => `  - '${p}'`).join("\n")}\n` } }]);

describe("requireFlakeNixInWorkflowsFilter", () => {
  test("passes on the real ci.yml", () => {
    expect(requireFlakeNixInWorkflowsFilter(CI, parseRepoYaml(CI))).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(requireFlakeNixInWorkflowsFilter(PATH, workflowsFilter([]))).toEqual([]);
  });

  test("fails when flake.nix is missing from the workflows filter", () => {
    const errors = requireFlakeNixInWorkflowsFilter(CI, workflowsFilter([".github/workflows/**"]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must include `flake.nix`");
  });

  test("accepts flake.nix in the workflows filter", () => {
    expect(requireFlakeNixInWorkflowsFilter(CI, workflowsFilter(["flake.nix"]))).toEqual([]);
  });

  test("fails when the workflows list is gone", () => {
    const document = job("changes", [{ with: { filters: "code:\n  - 'src/**'\n" } }]);
    expect(requireFlakeNixInWorkflowsFilter(CI, document)[0]).toContain("missing a `workflows` list");
  });

  test("fails when the changes job has no inline filters", () => {
    expect(requireFlakeNixInWorkflowsFilter(CI, { jobs: { changes: {} } })[0]).toContain("expected a `changes` job");
  });

  test("the file gate actually runs it", () => {
    const yaml = "jobs:\n  changes:\n    steps:\n      - with:\n          filters: |\n            workflows:\n              - '.github/workflows/**'\n";
    const path = join(mkdtempSync(join(tmpdir(), "kesha-wf-")), "ci.yml");
    writeFileSync(path, yaml);
    expect(checkFile(path, [], [], undefined, NO_SOURCES).filter((e) => e.includes("#1088"))).toHaveLength(1);
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

describe("requirePipefailShell", () => {
  const PIPED = { name: "record", run: "bun run check:versions | tee log" };
  const smoke = (job: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
    ...top,
    jobs: { smoke: { "runs-on": "ubuntu-latest", steps: [PIPED], ...job } },
  });
  const errorsFor = (document: unknown) => requirePipefailShell(CI, document);

  test("passes on every workflow in the repo", () => {
    for (const file of readdirSync(repoPath(".github/workflows"))) {
      const path = `.github/workflows/${file}`;
      expect([path, requirePipefailShell(path, parseRepoYaml(path))]).toEqual([path, []]);
    }
  });

  test("fails when a run step is left on the unspecified default", () => {
    const errors = errorsFor(smoke({}));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`smoke` step `record` has no `shell:`");
    expect(errors[0]).toContain("pipefail");
  });

  test("names an unnamed step by position", () => {
    expect(errorsFor(smoke({ steps: [{ run: "ls" }] }))[0]).toContain("step 1");
  });

  test("passes when the step, the job, or the workflow names bash", () => {
    expect(errorsFor(smoke({ steps: [{ ...PIPED, shell: "bash" }] }))).toEqual([]);
    expect(errorsFor(smoke({ defaults: { run: { shell: "bash" } } }))).toEqual([]);
    expect(errorsFor(smoke({}, { defaults: { run: { shell: "bash" } } }))).toEqual([]);
  });

  // `sh` is the one explicit choice that looks deliberate and still behaves like the default.
  test("fails on an explicit sh, which is the default trap spelled out", () => {
    const errors = errorsFor(smoke({ steps: [{ ...PIPED, shell: "sh" }] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("sets `shell: sh`");
  });

  test("passes on a shell that has no POSIX pipelines to get wrong", () => {
    for (const shell of ["pwsh", "powershell", "python"]) {
      expect(errorsFor(smoke({ steps: [{ ...PIPED, shell }] }))).toEqual([]);
    }
  });

  // GitHub runs cmd with the last program's error level and no fail-fast, which is sh's trap.
  test("fails on cmd, which reports the last program's error level", () => {
    expect(errorsFor(smoke({ steps: [{ ...PIPED, shell: "cmd" }] }))).toHaveLength(1);
  });

  // Windows defaults to pwsh, not `bash -e`; that lane is requireBashOnWindowsRunSteps (#850).
  test("leaves a windows-only job alone", () => {
    expect(errorsFor(smoke({ "runs-on": "windows-latest" }))).toEqual([]);
  });

  test("checks a matrix job for its non-windows legs", () => {
    const matrix = {
      "runs-on": "${{ matrix.os }}",
      strategy: { matrix: { os: ["ubuntu-latest", "windows-latest"] } },
    };
    expect(errorsFor(smoke(matrix))).toHaveLength(1);
  });

  test("ignores steps that only `uses` an action", () => {
    expect(errorsFor(smoke({ steps: [{ uses: "actions/checkout@v5" }] }))).toEqual([]);
  });

  // A gate is only a gate if checkFile still calls it, and the live suite cannot notice a
  // dropped check because the tree it reads is already clean.
  test("the file gate actually runs it", () => {
    const yaml = "on: push\njobs:\n  smoke:\n    runs-on: ubuntu-latest\n    steps:\n      - run: a | b\n";
    const path = join(mkdtempSync(join(tmpdir(), "kesha-wf-")), "probe.yml");
    writeFileSync(path, yaml);
    expect(checkFile(path, [], [], undefined, NO_SOURCES).filter((e) => e.includes("#1084"))).toHaveLength(1);
  });

  // Composite steps live under `runs.steps`, not `jobs`; an explicit `shell: sh` there is the same trap (#1089).
  const compositeAction = (steps: unknown[]) => ({ runs: { using: "composite", steps } });

  test("passes on every composite action in the repo", () => {
    for (const dir of readdirSync(repoPath(".github/actions"))) {
      const path = `.github/actions/${dir}/action.yml`;
      expect([path, requirePipefailShell(path, parseRepoYaml(path))]).toEqual([path, []]);
    }
  });

  test("fails on an explicit shell: sh inside a composite action's runs.steps", () => {
    const errors = requirePipefailShell(".github/actions/example/action.yml", compositeAction([{ ...PIPED, shell: "sh" }]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("sets `shell: sh`");
  });

  // Composite steps can't set defaults.run.shell — pointing authors at it would be a dead end.
  test("does not suggest defaults.run.shell for a composite action", () => {
    const errors = requirePipefailShell(".github/actions/example/action.yml", compositeAction([{ ...PIPED, shell: "sh" }]));
    expect(errors[0]).not.toContain("defaults.run.shell");
  });

  test("passes when a composite action's run step names bash", () => {
    expect(
      requirePipefailShell(".github/actions/example/action.yml", compositeAction([{ ...PIPED, shell: "bash" }])),
    ).toEqual([]);
  });

  // A composite can be consumed by a Windows job, so there is no runner to skip on (#1089).
  test("checks a composite action even though it has no runs-on to skip on", () => {
    expect(
      requirePipefailShell(".github/actions/example/action.yml", compositeAction([{ ...PIPED, shell: "sh" }])),
    ).toHaveLength(1);
  });

  test("ignores steps in a composite action that only `uses` another action", () => {
    expect(
      requirePipefailShell(".github/actions/example/action.yml", compositeAction([{ uses: "actions/checkout@v5" }])),
    ).toEqual([]);
  });

  test("the file gate actually runs it on a composite action", () => {
    const yaml = "name: Example\nruns:\n  using: composite\n  steps:\n    - run: a | b\n      shell: sh\n";
    const path = join(mkdtempSync(join(tmpdir(), "kesha-wf-")), "action.yml");
    writeFileSync(path, yaml);
    expect(checkFile(path, [], [], undefined, NO_SOURCES).filter((e) => e.includes("#1089"))).toHaveLength(1);
  });
});

describe("requireRestoreOnlyCachesHaveAWriter", () => {
  const SEED = ".github/workflows/cache-seed.yml";
  const writers = collectCacheWriters(parseRepoYaml(SEED));

  const reader = (inputs: Record<string, string>) =>
    job("smoke", [
      { name: "install", uses: "./.github/actions/install-kesha-backend", with: { "cache-write": "false", ...inputs } },
    ]);
  const MODELS = { "cache-key": "models-v1", "cache-path": "~/.cache/kesha\n~/.cache/fluidaudio\n" };
  const seeded = [{ key: "models-v1", paths: ["~/.cache/kesha", "~/.cache/fluidaudio"], crossOs: false }];
  const errorsFor = (document: unknown, entries = seeded) =>
    requireRestoreOnlyCachesHaveAWriter(CI, document, entries);

  test("every restore-only lane in the repo has a matching writer", () => {
    for (const file of readdirSync(repoPath(".github/workflows"))) {
      const path = `.github/workflows/${file}`;
      const errors = requireRestoreOnlyCachesHaveAWriter(path, parseRepoYaml(path), writers);
      expect([path, errors]).toEqual([path, []]);
    }
  });

  test("passes when the reader and the seed agree", () => {
    expect(errorsFor(reader(MODELS))).toEqual([]);
  });

  test("fails when no seed job writes the key it restores", () => {
    const errors = errorsFor(reader({ ...MODELS, "cache-key": "models-v2" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no cache-seed.yml job saves that key");
  });

  test("fails when the seed saves a different path set", () => {
    const errors = errorsFor(reader({ ...MODELS, "cache-path": "~/.cache/kesha" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("never hits");
  });

  test("fails when the two halves disagree about the cross-OS archive", () => {
    expect(errorsFor(reader({ ...MODELS, "cache-cross-os": "true" }))).toHaveLength(1);
  });

  // A lane that seeds itself owns its entry; the rule is about handing that job to cache-seed.yml.
  test("ignores a lane that still writes its own cache", () => {
    const document = reader({ ...MODELS, "cache-write": "${{ github.event_name != 'pull_request' }}" });
    expect(errorsFor(document)).toEqual([]);
  });

  test("collectCacheWriters reads a multi-line path block and the cross-OS flag", () => {
    const save = job("seed", [
      {
        uses: "actions/cache/save@55cc834",
        with: { path: ".kesha-ci-cache\n", key: "models-v3", enableCrossOsArchive: true },
      },
    ]);
    expect(collectCacheWriters(save)).toEqual([{ key: "models-v3", paths: [".kesha-ci-cache"], crossOs: true }]);
  });

  test("a restore step is not a writer", () => {
    const restore = job("seed", [{ uses: "actions/cache/restore@55cc834", with: { path: "x", key: "models-v3" } }]);
    expect(collectCacheWriters(restore)).toEqual([]);
  });
});

describe("requireDepsBeforeBunTest", () => {
  const TEST = { name: "test", run: "bun test tests/unit/derive-alpha-version.test.ts" };
  const INSTALL = { name: "install", run: "bun install --frozen-lockfile" };
  const SETUP = { uses: "./.github/actions/setup-bun" };

  test("passes on every workflow in the repo", () => {
    for (const path of readdirSync(repoPath(".github/workflows")).map((f) => `.github/workflows/${f}`)) {
      expect(requireDepsBeforeBunTest(path, parseRepoYaml(path))).toEqual([]);
    }
  });

  test("fails when a job runs bun test without installing dependencies", () => {
    const errors = requireDepsBeforeBunTest(PATH, job("decide", [TEST]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("runs `bun test` without installing dependencies first");
  });

  test("fails when the install runs after the tests", () => {
    expect(requireDepsBeforeBunTest(PATH, job("decide", [TEST, INSTALL]))).toHaveLength(1);
  });

  test("accepts a bun install step before it", () => {
    expect(requireDepsBeforeBunTest(PATH, job("decide", [INSTALL, TEST]))).toEqual([]);
  });

  test("accepts the setup-bun composite, which installs", () => {
    expect(requireDepsBeforeBunTest(PATH, job("decide", [SETUP, TEST]))).toEqual([]);
  });

  test("an install in another job does not count", () => {
    const document = { jobs: { setup: { steps: [INSTALL] }, decide: { steps: [TEST] } } };
    expect(requireDepsBeforeBunTest(PATH, document)).toHaveLength(1);
  });

  test("ignores a mention that is not a run", () => {
    expect(requireDepsBeforeBunTest(PATH, job("decide", [{ name: "x", run: 'echo "bun test"' }]))).toEqual([]);
  });
});

describe("Rust toolchain pin", () => {
  const PIN = { channel: "1.94.1", components: ["rustfmt", "clippy"] };

  test("the root toolchain file declares the exact compiler and developer components", () => {
    const { pin, errors } = readRustToolchainPin();
    expect(errors).toEqual([]);
    expect(pin).toEqual(PIN);
  });

  test("every explicit Rust CI setup installs the root compiler and components", () => {
    for (const file of readdirSync(repoPath(".github/workflows"))) {
      const path = `.github/workflows/${file}`;
      expect([path, requirePinnedRustToolchain(path, parseRepoYaml(path), PIN)]).toEqual([path, []]);
    }
  });
});

describe("requireJobTimeouts", () => {
  test("passes on every workflow in the repo", () => {
    for (const file of readdirSync(repoPath(".github/workflows"))) {
      const path = `.github/workflows/${file}`;
      expect([path, requireJobTimeouts(path, parseRepoYaml(path))]).toEqual([path, []]);
    }
  });

  test("ignores a job that calls a reusable workflow via `uses:`", () => {
    const doc = { jobs: { smoke: { uses: "./.github/workflows/release-install-smoke.yml" } } };
    expect(requireJobTimeouts(CI, doc)).toEqual([]);
  });

  // toEqual on the exact message, not toHaveLength: a mutant that neutralises the missing-value
  // check still emits one error (Number(undefined) is NaN), just with different text — only an
  // exact match tells the two branches apart.
  test("fails when a job with steps has no timeout-minutes", () => {
    const doc = { jobs: { lint: { "runs-on": "ubuntu-latest", steps: [{ run: "echo hi" }] } } };
    expect(requireJobTimeouts(CI, doc)).toEqual([
      `${CI}: \`lint\` has no \`timeout-minutes\`; an unattended stall burns GitHub's 360-minute default (#1105)`,
    ]);
  });

  // A bare `timeout-minutes:` with nothing after the colon parses to null, not undefined;
  // Number(null) is 0, which used to read as "0 minutes, valid" (#1105 review).
  test("fails when timeout-minutes is written with no value", () => {
    const doc = parse("jobs:\n  lint:\n    runs-on: ubuntu-latest\n    timeout-minutes:\n    steps:\n      - run: echo hi\n");
    expect(requireJobTimeouts(CI, doc)).toEqual([
      `${CI}: \`lint\` has no \`timeout-minutes\`; an unattended stall burns GitHub's 360-minute default (#1105)`,
    ]);
  });

  test("fails when timeout-minutes is 360 or higher", () => {
    const doc = { jobs: { lint: { "runs-on": "ubuntu-latest", "timeout-minutes": 360, steps: [{ run: "echo hi" }] } } };
    const errors = requireJobTimeouts(CI, doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not strictly below 360");
  });

  test("passes when timeout-minutes is under 360", () => {
    const doc = { jobs: { lint: { "runs-on": "ubuntu-latest", "timeout-minutes": 15, steps: [{ run: "echo hi" }] } } };
    expect(requireJobTimeouts(CI, doc)).toEqual([]);
  });

  // release-branch-engine-smoke's real shape: `timeout-minutes: ${{ matrix.timeout }}` with the
  // value living only in strategy.matrix.include, not a top-level matrix key.
  test("resolves a matrix-templated timeout-minutes per leg", () => {
    const doc = {
      jobs: {
        smoke: {
          "runs-on": "${{ matrix.os }}",
          "timeout-minutes": "${{ matrix.timeout }}",
          strategy: { matrix: { include: [{ os: "ubuntu-latest", timeout: 30 }, { os: "windows-latest", timeout: 400 }] } },
          steps: [{ run: "echo hi" }],
        },
      },
    };
    const errors = requireJobTimeouts(CI, doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("timeout-minutes: 400");
  });

  // A gate is only a gate if checkFile still calls it, and the live suite cannot notice a
  // dropped check because the tree it reads is already clean.
  test("the file gate actually runs it", () => {
    const yaml = "on: push\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
    const path = join(mkdtempSync(join(tmpdir(), "kesha-wf-")), "probe.yml");
    writeFileSync(path, yaml);
    expect(checkFile(path, [], [], undefined, NO_SOURCES).filter((e) => e.includes("#1105"))).toHaveLength(1);
  });
});

describe("requireReusableCallPermissions", () => {
  const SMOKE = "./.github/workflows/release-install-smoke.yml";

  test("passes on the real release-cli.yml", () => {
    expect(requireReusableCallPermissions(RELEASE_CLI, parseRepoYaml(RELEASE_CLI))).toEqual([]);
  });

  test("ignores a job that runs steps rather than calling a workflow", () => {
    expect(requireReusableCallPermissions(RELEASE_CLI, job("build", [UPLOAD]))).toEqual([]);
  });

  test("fails when the caller grants read and the callee asks for write", () => {
    const errors = requireReusableCallPermissions(RELEASE_CLI, {
      permissions: { contents: "read" },
      jobs: { smoke: { uses: SMOKE } },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("draft-engine");
    expect(errors[0]).toContain("fails to start");
  });

  test("passes once the calling job raises the scope itself", () => {
    expect(
      requireReusableCallPermissions(RELEASE_CLI, {
        permissions: { contents: "read" },
        jobs: { smoke: { uses: SMOKE, permissions: { contents: "write" } } },
      }),
    ).toEqual([]);
  });

  test("a job-level block replaces the workflow-level one rather than merging", () => {
    // The job grants only `actions`, so `contents` drops to none for the call — both callee jobs go unmet.
    const errors = requireReusableCallPermissions(RELEASE_CLI, {
      permissions: { contents: "write" },
      jobs: { smoke: { uses: SMOKE, permissions: { actions: "read" } } },
    });
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("requests \`contents: read\`");
    expect(errors.join("\n")).toContain("only grants \`contents: none\`");
  });

  test("reports a called workflow that does not exist", () => {
    const errors = requireReusableCallPermissions(RELEASE_CLI, {
      jobs: { smoke: { uses: "./.github/workflows/does-not-exist.yml" } },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("does not exist");
  });
});

describe("requireConcurrencyOnPullRequestWorkflows", () => {
  const RUST_TEST = ".github/workflows/rust-test.yml";
  const SYNTHETIC = ".github/workflows/synthetic.yml";
  const GROUP = "${{ github.workflow }}-${{ github.ref }}";

  test("passes on the real rust-test.yml", () => {
    expect(requireConcurrencyOnPullRequestWorkflows(RUST_TEST, parseRepoYaml(RUST_TEST))).toEqual([]);
  });

  test("passes on the real ci.yml", () => {
    expect(requireConcurrencyOnPullRequestWorkflows(CI, parseRepoYaml(CI))).toEqual([]);
  });

  test("fails a pull_request workflow with no concurrency at all", () => {
    const errors = requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, { on: { pull_request: null }, jobs: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#1105");
  });

  test("fails a group that does not interpolate github.ref", () => {
    const errors = requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, {
      on: { pull_request: null },
      concurrency: { group: "${{ github.workflow }}", "cancel-in-progress": true },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#597");
  });

  // A bare literal is one repository-wide group, so unrelated PRs would evict each other —
  // worse than no group at all, and `includes("github.ref")` alone accepts it.
  test("fails a literal github.ref that is not an expression", () => {
    const errors = requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, {
      on: { pull_request: null },
      concurrency: { group: "github.ref", "cancel-in-progress": true },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#597");
  });

  test("accepts github.ref composed with other expressions", () => {
    for (const group of [GROUP, "${{ github.ref }}", "rust-${{ github.ref }}-${{ github.event_name }}"]) {
      expect(
        requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, {
          on: { pull_request: null },
          concurrency: { group, "cancel-in-progress": true },
        }),
      ).toEqual([]);
    }
  });

  test("fails the concurrency string shorthand when it omits the ref", () => {
    expect(
      requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, { on: { pull_request: null }, concurrency: "one-lane" }),
    ).toHaveLength(1);
  });

  // Every spelling of one defect; review rounds 1-3 each closed one of these alone (#1105).
  test.each([
    ["bare literal", "github.ref"],
    ["single-quoted literal", "${{ 'github.ref' }}"],
    ["double-quoted literal", '${{ "github.ref" }}'],
    ["literal inside a call", "${{ format('github.ref') }}"],
    ["boolean sibling context", "${{ github.ref_protected }}"],
    ["short-name sibling context", "${{ github.ref_name }}"],
    ["type sibling context", "${{ github.ref_type }}"],
    ["no per-ref context at all", "${{ github.workflow }}"],
  ])("fails a group that does not vary per ref: %s", (_form, group) => {
    const errors = requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, {
      on: { pull_request: null },
      concurrency: { group, "cancel-in-progress": true },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#597");
  });

  // A `}` inside a string literal used to truncate the scan and reject these wrongly.
  test.each([
    ["composed via format", "${{ format('{0}', github.ref) }}"],
    ["brace inside a sibling literal", "${{ format('a}b') }}-${{ github.ref }}"],
  ])("accepts a group that varies per ref: %s", (_form, group) => {
    expect(
      requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, {
        on: { pull_request: null },
        concurrency: { group, "cancel-in-progress": true },
      }),
    ).toEqual([]);
  });

  // Yields two groups repo-wide; rejecting it needs an evaluator, not a longer pattern.
  test("accepts a boolean comparison over github.ref — the known residual", () => {
    expect(
      requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, {
        on: { pull_request: null },
        concurrency: { group: "${{ github.ref == 'refs/heads/main' }}", "cancel-in-progress": true },
      }),
    ).toEqual([]);
  });

  test("still accepts github.ref alongside a rejected sibling context", () => {
    expect(
      requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, {
        on: { pull_request: null },
        concurrency: { group: "${{ github.ref_protected }}-${{ github.ref }}", "cancel-in-progress": true },
      }),
    ).toEqual([]);
  });

  test.each([
    ["string", "pull_request"],
    ["array", ["push", "pull_request"]],
  ])("catches the %s trigger shorthand with no concurrency", (_form, on) => {
    const errors = requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, { on, jobs: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#1105");
  });

  test.each([
    ["string", "pull_request_target"],
    ["array", ["push", "pull_request_target"]],
  ])("ignores pull_request_target in the %s shorthand", (_form, on) => {
    expect(requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, { on, jobs: {} })).toEqual([]);
  });

  test("accepts a compliant workflow declared with the array shorthand", () => {
    expect(
      requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, {
        on: ["push", "pull_request"],
        concurrency: { group: GROUP, "cancel-in-progress": true },
      }),
    ).toEqual([]);
  });

  // pull_request_target is a different trigger with a different token; cache-cleanup.yml uses
  // it, and a prefix match would drag it in.
  test("ignores pull_request_target", () => {
    expect(
      requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, { on: { pull_request_target: { types: ["closed"] } } }),
    ).toEqual([]);
  });

  test("ignores a workflow that never runs on pull requests", () => {
    expect(
      requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, { on: { schedule: [{ cron: "0 4 * * *" }] }, jobs: {} }),
    ).toEqual([]);
  });

  // `pull_request:` with no body parses to null, so a truthiness test would skip the very
  // workflows this rule exists for.
  test("checks a pull_request trigger declared with no body", () => {
    expect(requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, { on: { pull_request: null } })).toHaveLength(1);
  });

  test("accepts a compliant pull_request workflow", () => {
    expect(
      requireConcurrencyOnPullRequestWorkflows(SYNTHETIC, {
        on: { pull_request: { branches: ["main"] } },
        concurrency: { group: GROUP, "cancel-in-progress": true },
      }),
    ).toEqual([]);
  });

  test("the file gate actually runs it", () => {
    const yaml =
      "on:\n  pull_request:\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - run: echo hi\n";
    const path = join(mkdtempSync(join(tmpdir(), "kesha-wf-")), "probe.yml");
    writeFileSync(path, yaml);
    expect(checkFile(path, [], [], undefined, NO_SOURCES).filter((e) => e.includes("#1105"))).toHaveLength(1);
  });
});

describe("requireBuildEngineSerialisesRunsPerRef", () => {
  const ref = { group: "${{ github.workflow }}-${{ github.ref }}", "cancel-in-progress": false };

  test("passes on the real build-engine.yml", () => {
    expect(requireBuildEngineSerialisesRunsPerRef(PATH, parseRepoYaml(PATH))).toEqual([]);
  });

  // rust-test.yml sets cancel-in-progress: true deliberately (#1105); this rule must not reach it.
  test("ignores every other workflow", () => {
    const RUST_TEST = ".github/workflows/rust-test.yml";
    expect(requireBuildEngineSerialisesRunsPerRef(RUST_TEST, parseRepoYaml(RUST_TEST))).toEqual([]);
  });

  test("fails when the group is constant across refs", () => {
    const errors = requireBuildEngineSerialisesRunsPerRef(PATH, {
      concurrency: { group: "build-engine", "cancel-in-progress": false },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#1108");
  });

  // Both of these mention github.ref, so groupVariesPerRef accepts them; only the exact pin rejects them.
  test("fails when a boolean group collapses every ref but one into a single lane", () => {
    const errors = requireBuildEngineSerialisesRunsPerRef(PATH, {
      concurrency: { group: "${{ github.ref == 'refs/tags/v1.0.1' }}", "cancel-in-progress": false },
    });
    expect(errors).toHaveLength(1);
  });

  test("fails when a run-scoped group serialises nothing", () => {
    const errors = requireBuildEngineSerialisesRunsPerRef(PATH, {
      concurrency: { group: `${ref.group}-\${{ github.run_id }}`, "cancel-in-progress": false },
    });
    expect(errors).toHaveLength(1);
  });

  test("fails when cancel-in-progress is true", () => {
    const errors = requireBuildEngineSerialisesRunsPerRef(PATH, {
      concurrency: { ...ref, "cancel-in-progress": true },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("mid-upload");
  });

  test("fails when cancel-in-progress is dropped entirely", () => {
    expect(
      requireBuildEngineSerialisesRunsPerRef(PATH, { concurrency: { group: ref.group } }),
    ).toHaveLength(1);
  });

  test("fails when the whole concurrency block is gone", () => {
    expect(requireBuildEngineSerialisesRunsPerRef(PATH, { on: { push: null }, jobs: {} })).toHaveLength(2);
  });

  test("the file gate actually runs it", () => {
    const yaml = "on:\n  push:\njobs: {}\n";
    const path = join(mkdtempSync(join(tmpdir(), "kesha-wf-")), "build-engine.yml");
    writeFileSync(path, yaml);
    expect(checkFile(path, [], [], undefined, NO_SOURCES).filter((e) => e.includes("#1108"))).toHaveLength(2);
  });
});

describe("requireReleaseVerifiesTagIsCurrent", () => {
  const GUARD = {
    name: "Verify tag has not been superseded",
    env: { TAG_NAME: "${{ github.ref_name }}" },
    run:
      'current="$(git ls-remote origin "refs/tags/$TAG_NAME" "refs/tags/$TAG_NAME^{}" | tail -1 | cut -f1)"\n' +
      'if [ "$current" != "$GITHUB_SHA" ]; then exit 1; fi\n',
  };
  const PUBLISH = { name: "Create draft release with binaries", uses: "softprops/action-gh-release@3d0d9888c" };

  test("passes on the real build-engine.yml", () => {
    expect(requireReleaseVerifiesTagIsCurrent(PATH, parseRepoYaml(PATH))).toEqual([]);
  });

  test("ignores every other workflow", () => {
    expect(requireReleaseVerifiesTagIsCurrent(CI, job("release", [PUBLISH]))).toEqual([]);
  });

  test("fails when the guard step is missing", () => {
    const errors = requireReleaseVerifiesTagIsCurrent(PATH, job("release", [PUBLISH]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#1115");
  });

  test("fails when the guard runs after the draft release is created", () => {
    const errors = requireReleaseVerifiesTagIsCurrent(PATH, job("release", [PUBLISH, GUARD]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("immediately before");
  });

  test("passes when the guard immediately precedes the draft release", () => {
    expect(requireReleaseVerifiesTagIsCurrent(PATH, job("release", [GUARD, PUBLISH]))).toEqual([]);
  });

  // An early-only check leaves the SBOM/download/sign window unrevalidated — the tag can still move before GitHub resolves it at publish time (#1115 review round 3, Greptile P1).
  test("fails when the guard runs early but not immediately before the draft release", () => {
    const OTHER = { name: "Generate source SBOM", uses: "anchore/sbom-action@e22c389" };
    const errors = requireReleaseVerifiesTagIsCurrent(PATH, job("release", [GUARD, OTHER, PUBLISH]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("immediately before");
  });

  test("fails when the guard step is disabled", () => {
    const errors = requireReleaseVerifiesTagIsCurrent(PATH, job("release", [{ ...GUARD, if: "false" }, PUBLISH]));
    expect(errors[0]).toContain("#1115");
  });

  // `${{ false }}` disables the step exactly like bare `false`, but a naive string-equality check misses it (#1115 review round 3, Greptile P2).
  test("fails when the guard step is disabled via a wrapped expression", () => {
    const errors = requireReleaseVerifiesTagIsCurrent(PATH, job("release", [{ ...GUARD, if: "${{ false }}" }, PUBLISH]));
    expect(errors[0]).toContain("#1115");
  });

  test("fails when the step never compares against GITHUB_SHA", () => {
    const noShaCheck = { ...GUARD, run: 'current="$(git ls-remote origin "refs/tags/$TAG_NAME^{}")"\necho "$current"\n' };
    expect(requireReleaseVerifiesTagIsCurrent(PATH, job("release", [noShaCheck, PUBLISH]))[0]).toContain("#1115");
  });

  test("fails when the step never mentions refs/tags", () => {
    const noTagRef = { ...GUARD, run: 'current="$GITHUB_SHA"\nif [ "$current" != "$GITHUB_SHA" ]; then exit 1; fi\n' };
    expect(requireReleaseVerifiesTagIsCurrent(PATH, job("release", [noTagRef, PUBLISH]))[0]).toContain("#1115");
  });

  test("fails when the release job is gone", () => {
    const errors = requireReleaseVerifiesTagIsCurrent(PATH, { jobs: { build: {} } });
    expect(errors[0]).toContain("expected a `release` job");
  });

  // `jobs: {}` alone reports "expected a `release` job", not #1115 — the probe needs a real job.
  test("the file gate actually runs it", () => {
    const yaml =
      "on:\n  push:\njobs:\n  release:\n    steps:\n      - uses: softprops/action-gh-release@3d0d9888c\n";
    const path = join(mkdtempSync(join(tmpdir(), "kesha-wf-")), "build-engine.yml");
    writeFileSync(path, yaml);
    expect(checkFile(path, [], [], undefined, NO_SOURCES).filter((e) => e.includes("#1115"))).toHaveLength(1);
  });
});

describe("requireRustTestCancelsSupersededRuns", () => {
  const RUST_TEST = ".github/workflows/rust-test.yml";
  const ref = { group: "${{ github.workflow }}-${{ github.ref }}" };

  test("passes on the real rust-test.yml", () => {
    expect(requireRustTestCancelsSupersededRuns(RUST_TEST, parseRepoYaml(RUST_TEST))).toEqual([]);
  });

  // security.yml sets `false` deliberately; auditing that is outside #1105, so this rule
  // must not reach it.
  test("ignores every other workflow", () => {
    const SECURITY = ".github/workflows/security.yml";
    expect(requireRustTestCancelsSupersededRuns(SECURITY, parseRepoYaml(SECURITY))).toEqual([]);
  });

  test("fails when cancel-in-progress is false", () => {
    const errors = requireRustTestCancelsSupersededRuns(RUST_TEST, {
      concurrency: { ...ref, "cancel-in-progress": false },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#1105");
  });

  test("fails when cancel-in-progress is dropped entirely", () => {
    expect(requireRustTestCancelsSupersededRuns(RUST_TEST, { concurrency: ref })).toHaveLength(1);
  });

  test("fails when the whole concurrency block is gone", () => {
    expect(requireRustTestCancelsSupersededRuns(RUST_TEST, { on: { pull_request: null } })).toHaveLength(1);
  });

  test("the file gate actually runs it", () => {
    const yaml = "on:\n  pull_request:\nconcurrency:\n  group: ${{ github.ref }}\n  cancel-in-progress: false\njobs: {}\n";
    const path = join(mkdtempSync(join(tmpdir(), "kesha-wf-")), "rust-test.yml");
    writeFileSync(path, yaml);
    expect(checkFile(path, [], [], undefined, NO_SOURCES).filter((e) => e.includes("#1105"))).toHaveLength(1);
  });
});

describe("forbidNixBuildInCiAggregator", () => {
  test("passes on the real ci.yml", () => {
    expect(forbidNixBuildInCiAggregator(CI, parseRepoYaml(CI))).toEqual([]);
  });

  test("fails when the aggregator needs nix-build", () => {
    const errors = forbidNixBuildInCiAggregator(CI, { jobs: { ci: { needs: ["unit-tests", "nix-build"] } } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("nix-build");
  });

  test("ignores workflows other than ci.yml", () => {
    const doc = { jobs: { ci: { needs: ["nix-build"] } } };
    expect(forbidNixBuildInCiAggregator(".github/workflows/rust-test.yml", doc)).toEqual([]);
  });

  // A gate is only a gate if checkFile still calls it, and the live suite cannot notice a gate
  // that was quietly unwired. The probe's jobs carry no `steps:` because `requireJobTimeouts`
  // has no path guard and interpolates the job name, so a `steps`-bearing `nix-build` would emit
  // a second error containing "nix-build" and this would pass asserting nothing (#1105).
  test("the file gate actually runs it", () => {
    const yaml = "on: push\njobs:\n  nix-build:\n    if: github.event_name == 'push'\n  ci:\n    needs: [nix-build]\n";
    const path = join(mkdtempSync(join(tmpdir(), "kesha-wf-")), "ci.yml");
    writeFileSync(path, yaml);
    expect(checkFile(path, [], [], undefined, NO_SOURCES).filter((e) => e.includes("nix-build"))).toHaveLength(1);
  });
});
