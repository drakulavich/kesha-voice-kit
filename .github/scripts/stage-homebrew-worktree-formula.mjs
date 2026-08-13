#!/usr/bin/env node
// Stage the committed Homebrew formula against HEAD for CI.
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
import { isEntry } from "./script-entry.mjs";

const NAME = "kesha-voice-kit";
const FORMULA_REL = `Formula/${NAME}.rb`;
const SRC_FORMULA = `packaging/homebrew/${FORMULA_REL}`;

function replaceOne(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`formula is missing ${label}`);
  return source.replace(pattern, replacement);
}

export function rewriteFormula(formula, { url, version, sha256 }) {
  const withUrl = replaceOne(
    formula,
    /^  url ".*"$/m,
    // A file:// url gives Homebrew no version to parse, and the formula's `test do`
    // asserts `version` matches `kesha --version`, so pin it from package.json.
    `  url "${url}"\n  version "${version}"`,
    "url",
  );
  return replaceOne(withUrl, /^  sha256 "[a-f0-9]{64}"$/m, `  sha256 "${sha256}"`, "sha256");
}

if (isEntry(import.meta.url)) {
  const usage = () => {
    console.error(
      "usage: node .github/scripts/stage-homebrew-worktree-formula.mjs --tap-dir path --archive path",
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

  // rewriteFormula validates both pins before returning, so the tap formula is
  // written only once a complete rewrite exists — never a partial one.
  const formula = rewriteFormula(readFileSync(SRC_FORMULA, "utf8"), {
    url: `file://${archivePath}`,
    version,
    sha256,
  });

  const formulaPath = join(tapDir, FORMULA_REL);
  mkdirSync(dirname(formulaPath), { recursive: true });
  writeFileSync(formulaPath, formula);
  console.log(`Staged ${NAME} ${version} from HEAD`);
  console.log(`archive: ${archivePath}`);
  console.log(`sha256: ${sha256}`);
}
