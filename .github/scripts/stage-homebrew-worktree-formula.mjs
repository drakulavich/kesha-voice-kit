#!/usr/bin/env node
// Stage the committed Homebrew formula against the WORKING TREE for CI.
//
// The published formula's `url` names a released tag, so `brew install
// --build-from-source` on it compiles a released source tree, never the
// checkout under review — the install block and the tree it ships with drift
// silently (#924, surfaced by #915). This rewrites a throwaway tap copy to
// build a `git archive` of HEAD instead, so the lane exercises the proposed
// install block against the code it lands with. The committed formula keeps its
// real release url/sha256; only this CI copy is rewritten.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const NAME = "kesha-voice-kit";
const FORMULA_REL = `Formula/${NAME}.rb`;
const SRC_FORMULA = `packaging/homebrew/${FORMULA_REL}`;

function usage() {
  console.error(
    "usage: node .github/scripts/stage-homebrew-worktree-formula.mjs --tap-dir path --archive path",
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

function replaceOne(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`formula is missing ${label}`);
  return source.replace(pattern, replacement);
}

const tapDir = getArg("--tap-dir");
const archiveArg = getArg("--archive");
if (!tapDir || !archiveArg) usage();

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
if (!version) throw new Error("package.json is missing a version");

const archivePath = resolve(archiveArg);
mkdirSync(dirname(archivePath), { recursive: true });
execFileSync(
  "git",
  ["archive", "--format=tar.gz", `--prefix=${NAME}-${version}/`, "-o", archivePath, "HEAD"],
  { stdio: ["ignore", "ignore", "inherit"] },
);

const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");

let formula = readFileSync(SRC_FORMULA, "utf8");
formula = replaceOne(
  formula,
  /^  url ".*"$/m,
  // A file:// url gives Homebrew no version to parse, and the formula's `test do`
  // asserts `version` matches `kesha --version`, so pin it from package.json.
  `  url "file://${archivePath}"\n  version "${version}"`,
  "url",
);
formula = replaceOne(
  formula,
  /^  sha256 "[a-f0-9]{64}"$/m,
  `  sha256 "${sha256}"`,
  "sha256",
);

const formulaPath = join(tapDir, FORMULA_REL);
mkdirSync(dirname(formulaPath), { recursive: true });
writeFileSync(formulaPath, formula);
console.log(`Staged ${NAME} ${version} from the working tree`);
console.log(`archive: ${archivePath}`);
console.log(`sha256: ${sha256}`);
