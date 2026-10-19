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
  const counts = new Map<string, number>();
  for await (const file of new Bun.Glob("src/**/*.{ts,mjs}").scan(repoPath("."))) {
    counts.set(file.replaceAll("\\", "/"), readRepoFile(file).split("throw new Error(").length - 1);
  }
  const extra: string[] = [];
  const stale: string[] = [];
  for (const file of new Set([...counts.keys(), ...ALLOWED.map(([path]) => path)])) {
    const count = counts.get(file) ?? 0;
    const allowed = ALLOWED.filter(([path]) => path === file).length;
    if (count > allowed) extra.push(`${file}: ${count} (allowed ${allowed})`);
    if (count < allowed) stale.push(`${file}: ${count} (allowed ${allowed})`);
  }
  expect(
    extra,
    `throw a KeshaError with a code from docs/errors.md and a hint instead:\n${extra.join("\n")}`,
  ).toEqual([]);
  expect(stale, `drop the stale ALLOWED entries:\n${stale.join("\n")}`).toEqual([]);
});
