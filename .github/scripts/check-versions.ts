#!/usr/bin/env bun
/**
 * Verify the three version sources stay aligned (#267 F16 / #313 P0):
 *
 *   - `package.json#version`              — npm-published CLI version
 *   - `package.json#keshaEngine.version`  — engine binary version the CLI
 *                                            downloads from GitHub Releases
 *   - `rust/Cargo.toml#version`           — engine crate version
 *
 * The release runbook in CLAUDE.md bumps all three by hand and reviewers
 * verify they agree. A silent drift between (b) and (c) means `kesha install`
 * downloads a release that doesn't match the source the engine was built
 * from — exactly the v1.1.0 incident where TTS shipped without being in the
 * build matrix.
 *
 * Rules enforced:
 *
 *   1. `keshaEngine.version === Cargo.toml#version`. These two are the
 *      "engine version" — the npm CLI uses (b) to pick the release tag,
 *      and (c) is the source-of-truth on what `cargo build` produces. They
 *      MUST match.
 *
 *   2. `package.json#version >= keshaEngine.version`. CLI-only patches
 *      (docs, TS fix, plugin tweak) bump (a) ahead of (b) per the
 *      "CLI AND ENGINE ARE VERSIONED INDEPENDENTLY" rule in CLAUDE.md.
 *      Engine releases bump (a) in lockstep. Either way (a) is >= (b).
 *
 * Exit 0 on success (no output). Exit 1 on any rule violation, printing
 * the offending values and the rule that was broken. Designed to be the
 * cheapest possible pre-push / CI guard — no deps beyond the bun runtime.
 *
 * Run: `bun .github/scripts/check-versions.ts` (or `bun run check:versions`
 * via package.json + `make versions`).
 */
import { readFileSync } from "node:fs";

type SemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseSemver(raw: string, label: string): SemVer {
  const m = raw.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  );
  if (!m) {
    console.error(`${label}: not a valid x.y.z semver (got '${raw}')`);
    process.exit(1);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4]?.split(".") ?? [],
  };
}

function cmp(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // SemVer precedence: a stable version outranks its prereleases.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;

    const an = ai.match(/^(0|[1-9]\d*)$/);
    const bn = bi.match(/^(0|[1-9]\d*)$/);
    if (an && bn) return Number(ai) - Number(bi);
    if (an) return -1;
    if (bn) return 1;
    return ai < bi ? -1 : 1;
  }

  return 0;
}

function fmt(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length ? `${base}-${v.prerelease.join(".")}` : base;
}

const pkgRaw = JSON.parse(readFileSync("package.json", "utf8"));
const cargoToml = readFileSync("rust/Cargo.toml", "utf8");

// `version = "..."` inside the [package] table is the first `version = ` in
// the file. Anchor the regex to the literal column-zero `version` so we
// don't accidentally pick up a workspace-member's version or a dependency
// version specifier inside a `[dependencies]` table.
const cargoVersionMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"$/m);
if (!cargoVersionMatch) {
  console.error("rust/Cargo.toml: missing top-level `version = \"x.y.z\"`");
  process.exit(1);
}

const cli = parseSemver(pkgRaw.version, "package.json#version");
const engine = parseSemver(
  pkgRaw.keshaEngine?.version ?? "",
  "package.json#keshaEngine.version",
);
const cargo = parseSemver(cargoVersionMatch[1], "rust/Cargo.toml#version");

let failed = false;

// Rule 1: engine.version === cargo#version
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

// Rule 2: cli.version >= engine.version
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
