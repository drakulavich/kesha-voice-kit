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
const DIRECT_CALL = new RegExp(`\\b${CALL_NAME}\\s*\\(`);

function directCallLines(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, index) => {
    if (DIRECT_CALL.test(line)) lines.push(index + 1);
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
const directCallers = sources
  .map((path) => ({ path, lines: directCallLines(readRepoFile(path)) }))
  .filter(({ lines }) => lines.length > 0);
const callerPaths = directCallers.map(({ path }) => path);

describe("temp directories under tests/", () => {
  // Without this the gate below passes when the walk or the pattern stops finding anything at all.
  test("the scan still reads the tree, and still recognises a direct call", () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(callerPaths).toContain("tests/helpers/temp-dir.ts");
    expect(sources).toContain("tests/unit/temp-dir-leak-guard.test.ts");
    expect(callerPaths).not.toContain("tests/unit/temp-dir-leak-guard.test.ts");
  });

  test("no file creates one the preloaded guard cannot reap", () => {
    const unlisted = directCallers.filter(({ path }) => EXEMPT[path] === undefined);
    if (unlisted.length === 0) return;

    const listed = unlisted.map(({ path, lines }) => `  ${path}:${lines.join(",")}`);
    throw new Error(
      `these files call mkdtempSync directly, so the directories they create outlive a failed, ` +
        `timed-out or interrupted test:\n${listed.join("\n")}\n\n` +
        `Use \`tempDir(prefix)\` from tests/helpers/temp-dir.ts, which registers the directory with ` +
        `the guard bunfig.toml preloads; removing it by hand as well stays safe. If a file must call ` +
        `mkdtempSync itself, add it to EXEMPT in tests/unit/temp-dir-convention.test.ts with the ` +
        `reason. The convention is written up in tests/integration/README.md.`,
    );
  });

  test("carries no stale exemptions", () => {
    for (const [path, reason] of Object.entries(EXEMPT)) {
      expect(reason.trim()).not.toBe("");
      expect(callerPaths).toContain(path);
    }
  });
});

describe("directCallLines", () => {
  test("names the line a call is on", () => {
    expect(directCallLines(`const a = 1;\nconst dir = ${CALL_NAME}(join(tmpdir(), "p-"));\n`)).toEqual([2]);
  });

  test("leaves a file that only imports the name alone", () => {
    expect(directCallLines(`import { ${CALL_NAME}, rmSync } from "node:fs";\nconst dir = tempDir("p-");\n`)).toEqual([]);
  });
});
