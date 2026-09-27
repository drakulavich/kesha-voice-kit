#!/usr/bin/env bun
/**
 * Verify the version sources stay aligned (openspec unified-release D1):
 *
 *   - `package.json#version`  — the one version of both the CLI and the Engine
 *   - `rust/Cargo.toml#version` — the Engine crate, which must mirror it
 *   - `server.json#version` + `#packages[].version` — the MCP registry manifest,
 *                                which points at an npm version that must exist
 *
 * No Engine pin is committed: `release.yml` injects `package.json#kesha.engine` at publish.
 */
import { readFileSync } from "node:fs";
import { cmp, fmt, parseSemver, type SemVer } from "../../src/semver.mjs";

function parseOrExit(raw: string, label: string): SemVer {
  try {
    return parseSemver(raw, label);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}


const pkgRaw = JSON.parse(readFileSync("package.json", "utf8"));
const cargoToml = readFileSync("rust/Cargo.toml", "utf8");
let serverJson: { version?: string; packages?: Array<{ version?: string }> };
try {
  serverJson = JSON.parse(readFileSync("server.json", "utf8"));
} catch (err) {
  console.error(
    `server.json: unreadable (${err instanceof Error ? err.message : String(err)}). ` +
      `It is the MCP registry manifest and must stay in the repo root.`,
  );
  process.exit(1);
}

// Anchor to column-zero `version` to avoid matching workspace-member or dependency version fields.
const cargoVersionMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"$/m);
if (!cargoVersionMatch) {
  console.error("rust/Cargo.toml: missing top-level `version = \"x.y.z\"`");
  process.exit(1);
}

const cli = parseOrExit(pkgRaw.version, "package.json#version");
const cargo = parseOrExit(cargoVersionMatch[1], "rust/Cargo.toml#version");

let failed = false;

if (cmp(cli, cargo) !== 0) {
  console.error(
    `rule 1 violated: rust/Cargo.toml#version (${fmt(cargo)}) must equal package.json#version ` +
      `(${fmt(cli)}). One tag builds and publishes both artifacts, so the Engine a release ` +
      `builds must carry the version the CLI resolves.`,
  );
  failed = true;
}

const committedPins = [
  ["package.json#keshaEngine", pkgRaw.keshaEngine],
  ["package.json#kesha.engine", pkgRaw.kesha?.engine],
].filter(([, value]) => value !== undefined);
for (const [label] of committedPins) {
  console.error(
    `rule 2 violated: ${label} must not be committed. The Engine a published CLI resolves is ` +
      `derived and injected when release.yml publishes it; a committed pin would override that ` +
      `for every source checkout and every lane.`,
  );
  failed = true;
}

const serverVersions: Array<[string, string]> = [
  ["server.json#version", serverJson.version ?? ""],
  ...(serverJson.packages ?? []).map(
    (pkg: { version?: string }, i: number): [string, string] => [
      `server.json#packages[${i}].version`,
      pkg.version ?? "",
    ],
  ),
];

for (const [label, raw] of serverVersions) {
  const parsed = parseOrExit(raw, label);
  if (cmp(parsed, cli) !== 0) {
    console.error(
      `rule 3 violated: ${label} (${fmt(parsed)}) must equal package.json#version ` +
        `(${fmt(cli)}). server.json is the MCP registry manifest: its version tells ` +
        `registries which npm release to resolve, so a stale value points clients at ` +
        `a version that was never published.`,
    );
    failed = true;
  }
}

if (failed) {
  console.error(
    `\nResolved sources:\n  package.json#version:              ${fmt(cli)}\n  rust/Cargo.toml#version:          ${fmt(cargo)}\n${serverVersions
      .map(([label, raw]) => `  ${label}:${" ".repeat(Math.max(1, 34 - label.length))}${raw}`)
      .join("\n")}`,
  );
  process.exit(1);
}
