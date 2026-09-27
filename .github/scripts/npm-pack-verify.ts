#!/usr/bin/env bun
/**
 * Pack the tarball npm would publish and refuse one that does not carry this release's version and
 * the Engine pin injected for it: npm publishes whatever the checkout holds.
 *
 * Usage: VERSION=… ENGINE_VERSION=… bun .github/scripts/npm-pack-verify.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEngine } from "../../src/package-info";

type Packed = { version?: unknown; keshaEngine?: { version?: unknown }; kesha?: { engine?: unknown } };

export function packedPackageProblems(pkg: Packed, want: { version: string; engineVersion: string }): string[] {
  const problems: string[] = [];
  if (pkg.version !== want.version) problems.push(`packed version is ${String(pkg.version)}, expected ${want.version}`);
  const engine = resolveEngine(pkg);
  if (!engine.pins) problems.push("packed package.json carries no kesha.engine pin");
  else if (engine.version !== want.engineVersion) {
    problems.push(`packed Engine pin is v${engine.version}, expected v${want.engineVersion}`);
  }
  return problems;
}

function run(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, { stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${result.exitCode}`);
  return result.stdout.toString();
}

if (import.meta.main) {
  const version = process.env.VERSION;
  const engineVersion = process.env.ENGINE_VERSION;
  if (!version || !engineVersion) {
    console.error("usage: VERSION=… ENGINE_VERSION=… bun .github/scripts/npm-pack-verify.ts");
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), "npm-pack-"));
  try {
    const tarball = run(["npm", "pack", "--silent", "--pack-destination", dir]).trim().split("\n").pop()!;
    const pkg = JSON.parse(run(["tar", "-xzOf", join(dir, tarball), "package/package.json"]));
    const problems = packedPackageProblems(pkg, { version, engineVersion });
    for (const problem of problems) console.error(`::error::${problem}`);
    if (problems.length > 0) process.exit(1);
    console.error(`${tarball} carries ${version} and Engine pin v${engineVersion}.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
