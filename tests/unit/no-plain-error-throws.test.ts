import { expect, test } from "bun:test";
import { readRepoFile, repoPath } from "../helpers/repo";

/** Each entry allows one occurrence in that file; a user-reachable failure throws a KeshaError instead. */
const ALLOWED: Array<[string, string]> = [
  ["src/diagnostic-log.ts", "its only caller drops the event at debug level"],
  ["src/diagnostic-log.ts", "its only caller drops the event at debug level"],
  ["src/diagnostic-log.ts", "its only caller drops the event at debug level"],
  ["src/diagnostic-log.ts", "its only caller drops the event at debug level"],
  ["src/stats.ts", "kesha stats retention validates the days before this call"],
  ["src/semver.mjs", "only called on the MIN_ENGINE_VERSION constant"],
  ["src/support-bundle.ts", "tar entry names are fixed bundle paths"],
  ["src/support-bundle.ts", "tar numeric fields are fixed modes and file sizes"],
  ["src/engine-install.ts", "fires only under NODE_ENV=test, to stop a test writing the real cache"],
  ["src/mcp/tools.ts", "the MCP SDK sends only message, which already carries the code and hint"],
  ["src/cli/install.ts", "both callers report it as E_INVALID_ARG"],
  ["src/cli/install.ts", "both callers report it as E_INVALID_ARG"],
];

test("src throws a plain Error only where ALLOWED says why", async () => {
  const hits: string[] = [];
  for await (const file of new Bun.Glob("src/**/*.{ts,mjs}").scan(repoPath("."))) {
    const count = readRepoFile(file).split("throw new Error(").length - 1;
    const allowed = ALLOWED.filter(([path]) => path === file).length;
    if (count > allowed) hits.push(`${file}: ${count} (allowed ${allowed})`);
  }
  expect(
    hits,
    `throw a KeshaError with a code from docs/errors.md and a hint instead:\n${hits.join("\n")}`,
  ).toEqual([]);
});
