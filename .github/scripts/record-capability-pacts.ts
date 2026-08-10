#!/usr/bin/env bun
/**
 * Record (or verify) one target's capability pact from a real engine binary.
 *
 * A pact is `--capabilities-json` frozen per released target, so a PR can gate flag routing
 * against every platform without running an engine. Its whole value is being a recording of
 * the artifact users actually get — never hand-edit one. Recording needs no models;
 * `--capabilities-json` is a compile-time dump.
 *
 *   bun .github/scripts/record-capability-pacts.ts --binary ./kesha-engine-linux-x64
 *   bun .github/scripts/record-capability-pacts.ts --from-release --check
 *
 * `--from-release` fetches the binary `keshaEngine.version` pins. `--check` re-derives the
 * pact and exits 1 on drift. Re-record per `.github/workflows/capability-pact.yml`, which
 * owns the procedure; a target can only be recorded on its own OS.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineTarget, engineTargetEntries, targetKey, type EngineTarget } from "../../src/engine-targets";
import { engineVersion } from "../../src/package-info";

const REPO = "drakulavich/kesha-voice-kit";
const PACT_DIR = join("tests", "fixtures", "capabilities");

/**
 * Provenance sits beside each pact rather than in one shared manifest: the three targets are
 * recorded on three runners that never see each other's output, and a shared file would let
 * whichever artifact is committed last overwrite the other two with its stale copies.
 */
export interface PactProvenance {
  engineVersion: string;
  assetName: string;
  /** SHA-256 of the recorded binary. `--check` re-hashes what it downloads and compares. */
  sha256: string;
  recordedFrom: string;
}

export function pactPath(key: string): string {
  return join(PACT_DIR, `${key}.json`);
}

export function provenancePath(key: string): string {
  return join(PACT_DIR, `${key}.provenance.json`);
}

function targetByKey(key: string): EngineTarget | undefined {
  return engineTargetEntries().find((e) => targetKey(e.platform, e.arch) === key)?.target;
}

/** Keys stay in the engine's own order, so an upstream reordering shows up as a diff. */
const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function usage(message: string): never {
  console.error(
    `${message}\n\nusage: record-capability-pacts.ts (--binary <path> | --from-release) [--target <key>] [--check]`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { binary: string; target: string; check: boolean; fromRelease: boolean } {
  let binary = "";
  let target = "";
  let check = false;
  let fromRelease = false;
  const operand = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("--")) usage(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--check") check = true;
    else if (arg === "--from-release") fromRelease = true;
    else if (arg === "--binary") binary = operand(arg, argv[++i]);
    else if (arg === "--target") target = operand(arg, argv[++i]);
    else usage(`unrecognised argument: ${arg}`);
  }
  if (!binary && !fromRelease) usage("pass --binary <path> or --from-release");
  if (binary && fromRelease) usage("--binary and --from-release are mutually exclusive");
  if (!target) {
    if (!engineTarget()) usage(`no published engine target for this host (${targetKey()}); pass --target`);
    target = targetKey();
  }
  // A binary only answers for the platform it was built for, so a matrix row whose runner and
  // target disagree would file that runner's shape under the wrong name.
  if (target !== targetKey()) {
    usage(`--target ${target} cannot be recorded on ${targetKey()}; run it on that target's own OS`);
  }
  return { binary, target, check, fromRelease };
}

/**
 * Fetch the pinned release's binary — the artifact `kesha install` hands users. ~65 MB of
 * executable, no models. A failure must be loud: a lane that quietly skips proves nothing (#838).
 */
async function downloadPinnedBinary(target: EngineTarget): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kesha-pact-"));
  const proc = Bun.spawn(
    ["gh", "release", "download", `v${engineVersion}`, "-R", REPO, "-p", target.assetName, "-D", dir],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) {
    console.error(
      `FAIL: could not download ${target.assetName} from v${engineVersion}.\n` +
        "  Check GH_TOKEN, and that the tag exists — between a release merge and its tag, " +
        "keshaEngine.version legitimately points at an unpublished release.",
    );
    process.exit(1);
  }
  const path = join(dir, target.assetName);
  if (process.platform !== "win32") chmodSync(path, 0o755);
  return path;
}

async function readCapabilities(binary: string): Promise<unknown> {
  const proc = Bun.spawn([binary, "--capabilities-json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    console.error(`${binary} --capabilities-json exited ${exitCode}`);
    if (stderr.trim()) console.error(stderr.trim());
    process.exit(1);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    console.error(`${binary} --capabilities-json did not emit JSON:\n${stdout}`);
    process.exit(1);
  }
}

const readNormalised = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const RE_RECORD =
  "Re-record per .github/workflows/capability-pact.yml: dispatch it with `record: true` and " +
  "commit the artifacts it uploads.";

function verify(target: string, binary: string, recorded: string): void {
  const path = pactPath(target);
  const provenance = provenancePath(target);
  if (!existsSync(path) || !existsSync(provenance)) {
    console.error(`FAIL: ${target} has no recorded pact. ${RE_RECORD}`);
    process.exit(1);
  }

  const previous = JSON.parse(readNormalised(provenance)) as PactProvenance;
  const failures: string[] = [];
  if (previous.engineVersion !== engineVersion) {
    failures.push(
      `recorded from engine v${previous.engineVersion} but keshaEngine.version pins v${engineVersion}`,
    );
  }
  const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (previous.sha256 !== sha256) {
    failures.push(`binary hashes to ${sha256}, provenance records ${previous.sha256}`);
  }
  const committed = readNormalised(path);
  if (committed !== recorded) {
    failures.push(`--- committed ${path}\n${committed}\n+++ ${binary} --capabilities-json\n${recorded}`);
  }

  if (failures.length === 0) {
    console.log(`${target}: pact matches the published binary (engine v${engineVersion}).`);
    return;
  }
  console.error(`FAIL: ${target} drifted from the real binary. ${RE_RECORD}\n`);
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

async function main(): Promise<void> {
  const { binary: given, target, check, fromRelease } = parseArgs(process.argv.slice(2));
  const asset = targetByKey(target);
  if (!asset) usage(`unknown target '${target}' — it has no row in src/engine-targets.ts`);

  const binary = fromRelease ? await downloadPinnedBinary(asset) : given;
  const recorded = serialize(await readCapabilities(binary));

  if (check) return verify(target, binary, recorded);

  writeFileSync(pactPath(target), recorded);
  writeFileSync(
    provenancePath(target),
    serialize({
      engineVersion,
      assetName: asset.assetName,
      sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
      recordedFrom: `${asset.assetName} from release v${engineVersion}`,
    } satisfies PactProvenance),
  );
  console.log(`Recorded ${pactPath(target)} and ${provenancePath(target)} for engine v${engineVersion}.`);
}

if (import.meta.main) await main();
