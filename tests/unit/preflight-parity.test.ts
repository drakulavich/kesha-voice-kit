import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";

const ROOT = join(import.meta.dir, "..", "..");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function checksIn(source: string): Set<string> {
  return new Set([...source.matchAll(/bun run (check:[a-z-]+)/g)].map((match) => match[1]!));
}

function preflightBody(): string {
  const justfile = read("justfile");
  const start = justfile.indexOf("\npreflight:");
  expect(start).toBeGreaterThan(-1);
  const rest = justfile.slice(start + 1);
  const end = rest.search(/\n[^\s#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

// A `just` recipe that interpolated a caller's value — shell injection — passed a green preflight
// and was caught only by check:recipes in CI, because preflight ran two of the six checks (#1070).
describe("preflight is the gate CLAUDE.md claims it is", () => {
  test("it runs every check the pull-request workflows run", () => {
    const workflows = readdirSync(join(ROOT, ".github", "workflows"))
      .filter((name) => name.endsWith(".yml"))
      // post-engine-release runs on a published tag, not on a pull request, and its checks
      // verify the release it just read rather than the tree a contributor is about to push.
      .filter((name) => name !== "post-engine-release.yml");

    const required = new Set<string>();
    for (const name of workflows) {
      for (const check of checksIn(read(join(".github", "workflows", name)))) required.add(check);
    }
    expect(required.size).toBeGreaterThan(0);

    const covered = checksIn(preflightBody());
    const missing = [...required].filter((check) => !covered.has(check)).sort();
    expect(missing).toEqual([]);
  });

  test("it reports a stale checkout rather than staying silent about it", () => {
    // The number is already computed for the gate selection; a checkout 14 commits behind had an
    // agent reading a stale CLAUDE.md for nine hours before anyone noticed (#1070).
    const body = preflightBody();
    expect(body).toContain("HEAD..origin/main");
    expect(body).toContain("behind origin/main");
  });
});
