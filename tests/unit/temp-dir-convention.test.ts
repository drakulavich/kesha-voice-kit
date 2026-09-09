import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { sep } from "node:path";
import { readRepoFile, repoPath } from "../helpers/repo";

// The temp-directory half of tests/unit/process-leak-guard.test.ts: fake-engine.ts documented a
// contract that told every call site to rmSync its own directory, and the ones that forgot at a
// single call site left 59,286 behind, which took the pre-push gate from 180s to 1154s (#1175).

// Exempt for now: each of these removes its directories by hand. Converting them is not this change.
const EXEMPT: Record<string, string> = {
  "tests/helpers/temp-dir.ts": "the helper itself — the one mkdtempSync call tempDir() wraps",
  "tests/helpers/fake-engine.ts": "converted where it leaked; isolateEngineCache() removes its directory in the undo it returns",
  "tests/helpers/git-repo.ts": "tracks its own directories, and cleanupGitRepos() removes them",
  "tests/integration/cli-contracts.test.ts": "removes its directories by hand; not yet converted",
  "tests/integration/compiled-cli-assets.test.ts": "removes its directories by hand; not yet converted",
  "tests/integration/error-codes-cli.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/check-versions.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/check-workflows.test.ts": "converted where it leaked; the remaining call sites remove their directories by hand",
  "tests/unit/diagnostic-log.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/doctor.test.ts": "converted where it leaked; the remaining call sites remove their directories by hand",
  "tests/unit/engine-install-concurrency.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/engine-install-decisions.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/engine-install.test.ts": "converted where it leaked; the remaining call sites remove their directories by hand",
  "tests/unit/engine-probe.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/engine-repair.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/engine-version-override.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/fluid-asr-cache.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/fluid-roots.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/install-lock.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/install-plan.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/kokoro-ane.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/logs-action.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/progress-stream.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/say-cli.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/star.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/stats-action.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/stats.test.ts": "removes its directories by hand; not yet converted",
  "tests/unit/status.test.ts": "removes its directories by hand; not yet converted",
};

const TESTS_DIR = "tests";

// Assembled from the name rather than written out: the scan below reads this file too.
const CALL_NAME = "mkdtempSync";
const ASYNC_CALL_NAME = CALL_NAME.replace("Sync", "");
const DIRECT_CALL = new RegExp(`\\b${ASYNC_CALL_NAME}(?:Sync)?\\s*\\(`);
// An alias renames the call, so the import is the only place the old shape is still spelled out.
const ALIASED_IMPORT = new RegExp(`\\b${ASYNC_CALL_NAME}(?:Sync)?\\s+as\\s+`);

function unreapableLines(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, index) => {
    if (DIRECT_CALL.test(line) || ALIASED_IMPORT.test(line)) lines.push(index + 1);
  });
  return lines;
}

function testSources(): string[] {
  return readdirSync(repoPath(TESTS_DIR), { recursive: true })
    .map((entry) => `${TESTS_DIR}/${String(entry).split(sep).join("/")}`)
    .filter((path) => path.endsWith(".ts"))
    .sort();
}

const sources = testSources();
const offenders = sources
  .map((path) => ({ path, lines: unreapableLines(readRepoFile(path)) }))
  .filter(({ lines }) => lines.length > 0);
const offenderPaths = offenders.map(({ path }) => path);

describe("temp directories under tests/", () => {
  // Without this the gate below passes when the walk or the pattern stops finding anything at all.
  test("the scan still reads the tree, and still recognises a direct call", () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(offenderPaths).toContain("tests/helpers/temp-dir.ts");
    expect(sources).toContain("tests/unit/temp-dir-leak-guard.test.ts");
    expect(offenderPaths).not.toContain("tests/unit/temp-dir-leak-guard.test.ts");
  });

  test("no file creates one the preloaded guard cannot reap", () => {
    const unlisted = offenders.filter(({ path }) => EXEMPT[path] === undefined);
    if (unlisted.length === 0) return;

    const listed = unlisted.map(({ path, lines }) => `  ${path}:${lines.join(",")}`);
    throw new Error(
      `these files reach ${CALL_NAME} without the guard, so the directories they create outlive a ` +
        `failed, timed-out or interrupted test:\n${listed.join("\n")}\n\n` +
        `Use \`tempDir(prefix)\` from tests/helpers/temp-dir.ts, which registers the directory with ` +
        `the guard bunfig.toml preloads; removing it by hand as well stays safe. If a file must call ` +
        `it itself, under either spelling or behind an alias, add it to EXEMPT in ` +
        `tests/unit/temp-dir-convention.test.ts with the reason. The convention is written up in ` +
        `tests/integration/README.md.`,
    );
  });

  test("carries no stale exemptions", () => {
    for (const [path, reason] of Object.entries(EXEMPT)) {
      expect(reason.trim()).not.toBe("");
      expect(offenderPaths).toContain(path);
    }
  });
});

describe("unreapableLines", () => {
  test("names the line a call is on", () => {
    expect(unreapableLines(`const a = 1;\nconst dir = ${CALL_NAME}(join(tmpdir(), "p-"));\n`)).toEqual([2]);
  });

  test("names the line the promise spelling is called on", () => {
    expect(unreapableLines(`const dir = await ${ASYNC_CALL_NAME}(join(tmpdir(), "p-"));\n`)).toEqual([1]);
  });

  test("names the import line an alias hides the call behind", () => {
    const source = `import { ${CALL_NAME} as mk } from "node:fs";\nconst dir = mk(join(tmpdir(), "p-"));\n`;
    expect(unreapableLines(source)).toEqual([1]);
  });

  test("leaves a file that only imports the name alone", () => {
    expect(unreapableLines(`import { ${CALL_NAME}, rmSync } from "node:fs";\nconst dir = tempDir("p-");\n`)).toEqual([]);
  });
});
