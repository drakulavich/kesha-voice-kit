#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { linuxPackageNames } from "./linux-package-names.mjs";
import {
  ENGINE_TAG_ERE,
  ENGINE_TAG_RE,
  isEngineAlphaTag,
  isStableTag,
} from "./release-tags.mjs";
import { cmp, parseSemver } from "../../src/semver.mjs";

const REPOSITORY = "drakulavich/kesha-voice-kit";
const MANIFEST_NAME = "kesha-release-manifest.json";

const ENGINE_ASSETS = [
  {
    id: "darwin-arm64",
    os: "darwin",
    arch: "arm64",
    status: "supported",
    engineAsset: "kesha-engine-darwin-arm64",
    install: { directory: "engine/bin", filename: "kesha-engine" },
  },
  {
    id: "linux-x64",
    os: "linux",
    arch: "x64",
    status: "supported",
    engineAsset: "kesha-engine-linux-x64",
    install: { directory: "engine/bin", filename: "kesha-engine" },
  },
  {
    id: "windows-x64",
    os: "win32",
    arch: "x64",
    status: "supported",
    engineAsset: "kesha-engine-windows-x64.exe",
    // The installed name keeps the suffix: an extensionless PE is not reliably spawnable (#216).
    install: { directory: "engine/bin", filename: "kesha-engine.exe" },
  },
];

// Kokoro (#207) and diarization (#199) run in-engine now (native fluidaudio-rs),
// so only AVSpeech and text-lang ship as separate Swift-sidecar assets.
const DARWIN_SIDECARS = [
  {
    name: "say-avspeech-darwin-arm64",
    install: { directory: "engine/bin", filename: "say-avspeech" },
  },
  {
    name: "kesha-textlang-darwin-arm64",
    install: { directory: "engine/bin", filename: "kesha-textlang" },
  },
];

function linuxPackageAssets(version) {
  const packages = linuxPackageNames(version);
  return [
    {
      name: packages.deb,
      kind: "package",
      platforms: ["linux-x64"],
      install: {
        packageManager: "apt",
        command: `sudo apt install ./${packages.deb}`,
      },
    },
    {
      name: packages.rpm,
      kind: "package",
      platforms: ["linux-x64"],
      install: {
        packageManager: "dnf",
        command: `sudo dnf install ./${packages.rpm}`,
      },
    },
  ];
}

function usage() {
  console.error(
    "usage: node .github/scripts/release-manifest.mjs [--tag vX.Y.Z[-beta.N|-alpha.N]] [--out path] [--check]",
  );
  process.exit(2);
}

function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function readPackage() {
  return JSON.parse(readFileSync("package.json", "utf8"));
}

function asset(name, kind, platforms, install, checksummed = true) {
  return {
    name,
    kind,
    platforms,
    ...(install ? { install } : {}),
    checksummed,
    signatureBundle: `${name}.sigstore.json`,
  };
}

/**
 * An alpha is published ahead of the pin, never as it.
 *
 * The pin names the *released* engine and may never name an alpha (#738), so an alpha tag
 * cannot be required to equal it. Requiring it to outrank the pin keeps what the exact-match
 * rule was protecting: `v1.24.8-alpha.1` against a pin already at `1.24.8` sorts below it and
 * is still refused, so an alpha can never stand in for the stable release of its own base.
 */
function assertTagNamesThisRelease(tag, pinnedVersion) {
  const version = tag.slice(1);
  if (version === pinnedVersion) return;

  const ahead =
    isEngineAlphaTag(tag) &&
    cmp(parseSemver(version, "release tag"), parseSemver(pinnedVersion, "pinned engine version")) > 0;
  if (ahead) return;

  throw new Error(
    `release tag ${tag} must match package.json#keshaEngine.version (${pinnedVersion})` +
      (isEngineAlphaTag(tag) ? ` or name an alpha above it` : ""),
  );
}

function buildManifest(tag) {
  const pkg = readPackage();
  const pinnedVersion = pkg.keshaEngine?.version ?? pkg.version;
  if (typeof pkg.version !== "string" || typeof pinnedVersion !== "string") {
    throw new Error("package.json must contain version and keshaEngine.version strings");
  }

  const sbomName = `kesha-voice-kit-${tag}.spdx.json`;
  // Every tag here is an engine tag, stable included; the CLI version names packages (#696).
  assertTagNamesThisRelease(tag, pinnedVersion);

  // The tag, not the pin: an alpha ships a version no commit carries (#685).
  const engineVersion = tag.slice(1);

  const assets = [
    ...ENGINE_ASSETS.map((p) => asset(p.engineAsset, "engine", [p.id], p.install)),
    ...DARWIN_SIDECARS.map((s) => asset(s.name, "sidecar", ["darwin-arm64"], s.install)),
    ...(isStableTag(tag)
      ? linuxPackageAssets(pkg.version).map((p) =>
          asset(p.name, p.kind, p.platforms, p.install),
        )
      : []),
    asset(sbomName, "sbom", []),
    asset(MANIFEST_NAME, "manifest", []),
    asset("SHA256SUMS", "checksum", [], undefined, false),
  ];

  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    tag,
    cliVersion: pkg.version,
    engineVersion,
    packaging: {
      runtime: "bun",
      userInstall: "bun add -g @drakulavich/kesha-voice-kit",
      manifestPurpose:
        "Release metadata for package-manager channels; it does not replace the Bun-first user install path.",
    },
    verification: {
      checksumAsset: "SHA256SUMS",
      sigstoreBundleSuffix: ".sigstore.json",
    },
    platforms: ENGINE_ASSETS.map((p) => ({
      id: p.id,
      os: p.os,
      arch: p.arch,
      status: p.status,
      engineAsset: p.engineAsset,
      ...(p.note ? { note: p.note } : {}),
    })),
    assets,
  };
}

function assertIncludes(source, needle, file) {
  if (!source.includes(needle)) {
    throw new Error(`${file} is missing release manifest token: ${needle}`);
  }
}

function validateSourceConsistency(manifest) {
  const installer = readFileSync("src/engine-install.ts", "utf8");
  // Asset names moved out of engine-install.ts into the one platform table (#216).
  const targets = readFileSync("src/engine-targets.ts", "utf8");
  const workflow = readFileSync(".github/workflows/build-engine.yml", "utf8");

  for (const p of ENGINE_ASSETS) {
    if (p.status === "supported") {
      assertIncludes(targets, p.engineAsset, "src/engine-targets.ts");
    }
    assertIncludes(workflow, p.engineAsset, ".github/workflows/build-engine.yml");
  }

  for (const s of DARWIN_SIDECARS) {
    assertIncludes(installer, `assetName: "${s.name}"`, "src/engine-install.ts");
    assertIncludes(installer, `fileBasename: "${s.install.filename}"`, "src/engine-install.ts");
    assertIncludes(workflow, s.name, ".github/workflows/build-engine.yml");
  }

  // The bash validator must ship the exact grammar string, so the two languages cannot drift (#685).
  assertIncludes(workflow, ENGINE_TAG_ERE, ".github/workflows/build-engine.yml");
  assertIncludes(workflow, "SHA256SUMS", ".github/workflows/build-engine.yml");
  assertIncludes(workflow, ".sigstore.json", ".github/workflows/build-engine.yml");
  assertIncludes(workflow, "build-linux-packages.mjs", ".github/workflows/build-engine.yml");
  assertIncludes(workflow, "dist/linux-packages/*.{deb,rpm}", ".github/workflows/build-engine.yml");

  const packageScript = readFileSync(".github/scripts/build-linux-packages.mjs", "utf8");
  const packageNames = readFileSync(".github/scripts/linux-package-names.mjs", "utf8");
  const nfpmConfig = readFileSync("packaging/nfpm.yaml", "utf8");
  assertIncludes(packageScript, "--target=bun-linux-x64", ".github/scripts/build-linux-packages.mjs");
  assertIncludes(packageScript, "packaging/nfpm.yaml", ".github/scripts/build-linux-packages.mjs");
  assertIncludes(packageScript, "LINUX_PACKAGE_RELEASE", ".github/scripts/build-linux-packages.mjs");
  assertIncludes(packageNames, "LINUX_PACKAGE_RELEASE", ".github/scripts/linux-package-names.mjs");
  assertIncludes(nfpmConfig, "dst: /usr/bin/kesha", "packaging/nfpm.yaml");

  const names = new Set();
  for (const a of manifest.assets) {
    if (names.has(a.name)) throw new Error(`duplicate release manifest asset: ${a.name}`);
    names.add(a.name);
    if (!a.signatureBundle.endsWith(manifest.verification.sigstoreBundleSuffix)) {
      throw new Error(`bad sigstore bundle name for ${a.name}: ${a.signatureBundle}`);
    }
  }
}

const pkg = readPackage();
const defaultTag = `v${pkg.keshaEngine?.version ?? pkg.version}`;
const tag = getArg("--tag") ?? defaultTag;
if (!ENGINE_TAG_RE.test(tag)) {
  throw new Error(
    `release manifest tag must look like vX.Y.Z, vX.Y.Z-beta.N or vX.Y.Z-alpha.N, got: ${tag}`,
  );
}

const manifest = buildManifest(tag);
validateSourceConsistency(manifest);

const out = getArg("--out");
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
} else if (!hasArg("--check")) {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
