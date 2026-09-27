import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";

const SCRIPT = `${REPO_ROOT}/.github/scripts/check-versions.ts`;

type Fixture = { cli: string; cargo?: string; server?: string | null; extra?: Record<string, unknown> };

// Nothing here is symlinked to the repo, so the fixture is safe to remove recursively.
async function check({ cli, cargo = cli, server = cli, extra = {} }: Fixture) {
  const dir = tempDir("kesha-versions-");
  try {
    mkdirSync(join(dir, "rust"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: cli, ...extra }));
    writeFileSync(join(dir, "rust/Cargo.toml"), `version = "${cargo}"\n`);
    if (server !== null) {
      writeFileSync(join(dir, "server.json"), JSON.stringify({ version: server, packages: [{ version: server }] }));
    }
    const proc = Bun.spawn(["bun", SCRIPT], { cwd: dir, stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    return { accepted: (await proc.exited) === 0, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("one version for both artifacts", () => {
  test("package.json, Cargo.toml and server.json at one version pass", async () => {
    expect((await check({ cli: "1.32.0" })).accepted).toBe(true);
  });

  test("a Cargo.toml that differs from package.json#version fails, naming both", async () => {
    const { accepted, stderr } = await check({ cli: "1.32.0", cargo: "1.26.0" });
    expect(accepted).toBe(false);
    expect(stderr).toContain("rule 1 violated");
    expect(stderr).toContain("1.26.0");
    expect(stderr).toContain("1.32.0");
  });

  test("a committed keshaEngine pin fails, naming the field", async () => {
    const { accepted, stderr } = await check({ cli: "1.32.0", extra: { keshaEngine: { version: "1.32.0" } } });
    expect(accepted).toBe(false);
    expect(stderr).toContain("package.json#keshaEngine");
    expect(stderr).toContain("rule 2 violated");
  });

  test("a committed kesha.engine pin fails: it is injected at publish, never committed", async () => {
    const { accepted, stderr } = await check({ cli: "1.32.0", extra: { kesha: { engine: { version: "1.32.0", sha256: {} } } } });
    expect(accepted).toBe(false);
    expect(stderr).toContain("package.json#kesha.engine");
  });
});

describe("server.json", () => {
  test("a server.json version behind package.json fails", async () => {
    const { accepted, stderr } = await check({ cli: "1.32.0", server: "1.31.0" });
    expect(accepted).toBe(false);
    expect(stderr).toContain("rule 3 violated");
  });

  test("a missing server.json fails with the reason", async () => {
    const { accepted, stderr } = await check({ cli: "1.32.0", server: null });
    expect(accepted).toBe(false);
    expect(stderr).toContain("MCP registry manifest");
  });
});

test("the repository itself passes", () => {
  const run = Bun.spawnSync(["bun", SCRIPT], { cwd: REPO_ROOT });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
});
