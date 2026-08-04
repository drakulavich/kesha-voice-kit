#!/usr/bin/env bun
/**
 * Verify the three version sources stay aligned (#267 F16 / #313 P0):
 *
 *   - `package.json#version`              — npm-published CLI version
 *   - `package.json#keshaEngine.version`  — engine binary version the CLI
 *                                            downloads from GitHub Releases
 *   - `rust/Cargo.toml#version`           — engine crate version
 *
 * A silent drift between (b) and (c) means `kesha install` downloads a
 * release that doesn't match the source the engine was built from —
 * exactly the v1.1.0 incident where TTS shipped without being in the
 * build matrix.
 */
import { readFileSync } from "node:fs";
import { cmp, fmt, parseSemver, type SemVer } from "./semver";

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

// Anchor to column-zero `version` to avoid matching workspace-member or dependency version fields.
const cargoVersionMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"$/m);
if (!cargoVersionMatch) {
  console.error("rust/Cargo.toml: missing top-level `version = \"x.y.z\"`");
  process.exit(1);
}

const cli = parseOrExit(pkgRaw.version, "package.json#version");
const engine = parseOrExit(
  pkgRaw.keshaEngine?.version ?? "",
  "package.json#keshaEngine.version",
);
const cargo = parseOrExit(cargoVersionMatch[1], "rust/Cargo.toml#version");

let failed = false;

if (cmp(engine, cargo) !== 0) {
  console.error(
    `rule 1 violated: package.json#keshaEngine.version (${fmt(engine)}) ` +
      `must equal rust/Cargo.toml#version (${fmt(cargo)}). ` +
      `The npm CLI uses keshaEngine.version to pick a GitHub Release tag; ` +
      `Cargo.toml drives what's actually compiled. If they disagree, ` +
      `\`kesha install\` downloads a binary that doesn't match the source.`,
  );
  failed = true;
}

if (cmp(cli, engine) < 0) {
  console.error(
    `rule 2 violated: package.json#version (${fmt(cli)}) must be >= ` +
      `package.json#keshaEngine.version (${fmt(engine)}). ` +
      `CLI version is allowed to lead engine version for CLI-only patches ` +
      `(see CLAUDE.md → "CLI AND ENGINE ARE VERSIONED INDEPENDENTLY"), ` +
      `but it must never lag behind.`,
  );
  failed = true;
}

if (failed) {
  console.error(
    `\nResolved sources:\n  package.json#version:              ${fmt(cli)}\n  package.json#keshaEngine.version: ${fmt(engine)}\n  rust/Cargo.toml#version:          ${fmt(cargo)}`,
  );
  process.exit(1);
}
