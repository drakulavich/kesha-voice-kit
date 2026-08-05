import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = `${import.meta.dir}/../..`;
const SCRIPT = `${REPO}/.github/scripts/check-versions.ts`;

// Nothing here is symlinked to the repo, so the fixture is safe to remove recursively.
async function check(cli: string, engine: string, cargo = engine) {
  const dir = mkdtempSync(join(tmpdir(), "kesha-versions-"));
  try {
    mkdirSync(join(dir, "rust"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ version: cli, keshaEngine: { version: engine } }),
    );
    writeFileSync(join(dir, "rust/Cargo.toml"), `version = "${cargo}"\n`);
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

  test("the repository's own pin passes every rule", async () => {
    const pkg = await Bun.file(`${REPO}/package.json`).json();

    expect((await check(pkg.version, pkg.keshaEngine.version)).accepted).toBe(true);
  });
});
