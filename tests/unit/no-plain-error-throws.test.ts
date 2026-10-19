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
  ["src/cli/install.ts", "both callers report it as E_INVALID_ARG"],
  ["src/cli/install.ts", "both callers report it as E_INVALID_ARG"],
  ["src/mcp/tools.ts", "MCP SDK copies the numeric code into the JSON-RPC error; the message already carries the E_ code and hint"],
];

test("src builds a plain Error only where ALLOWED says why", async () => {
  const counts = new Map<string, number>();
  for await (const file of new Bun.Glob("src/**/*.{ts,mjs}").scan(repoPath("."))) {
    counts.set(file.replaceAll("\\", "/"), readRepoFile(file).split("new Error(").length - 1);
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
    `build a KeshaError with a code from docs/errors.md and a hint instead of new Error(:\n${extra.join("\n")}`,
  ).toEqual([]);
  expect(stale, `drop the stale ALLOWED entries:\n${stale.join("\n")}`).toEqual([]);
});
