#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isStableTag } from "./release-tags.mjs";
import { rewriteFormula } from "./stage-homebrew-worktree-formula.mjs";
import { isEntry } from "./script-entry.mjs";

const REPOSITORY = "drakulavich/kesha-voice-kit";
const FORMULA_REL = "Formula/kesha-voice-kit.rb";

export async function sha256ForUrl(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return createHash("sha256").update(bytes).digest("hex");
}

export async function versionForTag(tag, fetchImpl = fetch) {
  const url = `https://raw.githubusercontent.com/${REPOSITORY}/${tag}/package.json`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
  }
  const pkg = await res.json();
  if (!pkg.version) throw new Error(`package.json at ${tag} is missing a version`);
  return pkg.version;
}

export async function buildUpdatedFormula({ tag, formula, fetchImpl = fetch }) {
  if (!isStableTag(tag)) {
    throw new Error(`Homebrew tap updates only support stable vX.Y.Z tags, got: ${tag}`);
  }

  const tarballUrl = `https://github.com/${REPOSITORY}/archive/refs/tags/${tag}.tar.gz`;
  const [sha256, cliVersion] = await Promise.all([
    sha256ForUrl(tarballUrl, fetchImpl),
    versionForTag(tag, fetchImpl),
  ]);

  const tagVersion = tag.slice(1);
  // Homebrew scans this exact string out of the archive/refs/tags url itself; an explicit
  // version equal to it fails `brew audit --strict` as redundant (#1105).
  const version = cliVersion === tagVersion ? null : cliVersion;

  return rewriteFormula(formula, { url: tarballUrl, version, sha256 });
}

if (isEntry(import.meta.url)) {
  const usage = () => {
    console.error(
      "usage: node .github/scripts/update-homebrew-tap.mjs --tag vX.Y.Z --tap-dir path",
    );
    process.exit(2);
  };

  const getArg = (name) => {
    const i = process.argv.indexOf(name);
    if (i === -1) return undefined;
    const value = process.argv[i + 1];
    if (!value || value.startsWith("--")) usage();
    return value;
  };

  const tag = getArg("--tag");
  const tapDir = getArg("--tap-dir");
  if (!tag || !tapDir) usage();

  const formulaPath = join(tapDir, FORMULA_REL);
  const formula = await buildUpdatedFormula({ tag, formula: readFileSync(formulaPath, "utf8") });

  mkdirSync(dirname(formulaPath), { recursive: true });
  writeFileSync(formulaPath, formula);

  const url = formula.match(/^  url "(.*)"$/m)?.[1];
  const sha256 = formula.match(/^  sha256 "([a-f0-9]{64})"$/m)?.[1];
  const version = formula.match(/^  version "(.*)"$/m)?.[1];
  console.log(`Updated ${FORMULA_REL} for ${tag}`);
  console.log(`url: ${url}`);
  console.log(`sha256: ${sha256}`);
  console.log(version ? `version: ${version}` : "version: left to Homebrew's URL inference (matches the tag)");
}
