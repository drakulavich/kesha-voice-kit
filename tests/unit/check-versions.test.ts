import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = `${import.meta.dir}/../..`;
const SCRIPT = `${REPO}/.github/scripts/check-versions.ts`;

// Nothing here is symlinked to the repo, so the fixture is safe to remove recursively.
async function check(cli: string, engine: string, cargo = engine, server: string | null = cli) {
  const dir = mkdtempSync(join(tmpdir(), "kesha-versions-"));
  try {
    mkdirSync(join(dir, "rust"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ version: cli, keshaEngine: { version: engine } }),
    );
    writeFileSync(join(dir, "rust/Cargo.toml"), `version = "${cargo}"\n`);
    if (server !== null) {
      writeFileSync(
        join(dir, "server.json"),
        JSON.stringify({ version: server, packages: [{ version: server }] }),
      );
    }
    const proc = Bun.spawn(["bun", SCRIPT], { cwd: dir, stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    return { accepted: (await proc.exited) === 0, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("engine pin channel", () => {
  test("an alpha engine pin is rejected", async () => {
    const { accepted, stderr } = await check("1.27.0", "1.24.8-alpha.1");

    expect(accepted).toBe(false);
    expect(stderr).toContain("rule 3 violated");
  });

  // Betas have legitimately sat on main (1.22.0-beta.2) — a release candidate is what CI
  // should be exercising, unlike a throwaway alpha.
  test("a beta engine pin is allowed", async () => {
    expect((await check("1.27.0", "1.24.8-beta.1")).accepted).toBe(true);
  });

  test("a stable engine pin is allowed", async () => {
    expect((await check("1.27.0", "1.24.8")).accepted).toBe(true);
  });

  // Alpha-shaped, not `prerelease[0] === "alpha"`: the rule is about what the pin means.
  test("an alpha in any casing or position is rejected", async () => {
    for (const pin of ["1.24.8-Alpha.1", "1.24.8-alpha1", "1.24.8-0.alpha.1"]) {
      expect((await check("1.27.0", pin)).accepted).toBe(false);
    }
  });

  test("other prerelease channels are left alone", async () => {
    for (const pin of ["1.24.8-rc.1", "1.24.8-pre.1"]) {
      expect((await check("1.27.0", pin)).accepted).toBe(true);
    }
  });
});

// A stale server.json advertises an npm version that was never published.
describe("MCP registry manifest", () => {
  test("a server.json version lagging package.json#version is rejected", async () => {
    const { accepted, stderr } = await check("1.27.0", "1.24.8", "1.24.8", "1.26.0");

    expect(accepted).toBe(false);
    expect(stderr).toContain("rule 4 violated");
    expect(stderr).toContain("server.json#version");
  });

  test("a missing server.json is reported, not thrown", async () => {
    const { accepted, stderr } = await check("1.27.0", "1.24.8", "1.24.8", null);

    expect(accepted).toBe(false);
    expect(stderr).toContain("server.json: unreadable");
  });

  // In the real cwd, so rule 1 reads the actual rust/Cargo.toml rather than a fixture
  // written to agree with the pin by construction.
  test("the repository itself passes every rule, Cargo.toml and server.json included", async () => {
    const proc = Bun.spawn(["bun", SCRIPT], { cwd: REPO, stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();

    expect(stderr).toBe("");
    expect(await proc.exited).toBe(0);
  });
});
