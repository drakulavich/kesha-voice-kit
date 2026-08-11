#!/usr/bin/env bun
/**
 * Convert a JUnit XML report and upload it to Flakiness.io, normalising the
 * reported macOS version on the way through.
 *
 * Flakiness.io identifies an environment by the reported OS version *including
 * the patch component*, and test history never crosses environment boundaries.
 * `macos-latest` produced five environments in 90 days (15.7.4, 15.7.5, 15.7.7,
 * 26.4, 26.5.2), each starting from empty history — which makes rare-flake
 * detection impossible. Truncating to major.minor before upload stops the
 * patch-level forks. Forward-only: `26.5` is a *new* environment, so the
 * existing `26.5.2` rows do not migrate into it. Ubuntu and Windows are left
 * alone because their reported versions have not drifted.
 *
 * Usage: bun .github/scripts/upload-flakiness.ts <junit-path> <category> [project]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MACOS_NORMALISED = /^\d+\.\d+$/;

// Pinned: a floating version is unreviewed code with OIDC access (Greptile #699 P2).
const CONVERTER = "@flakiness/junit-xml@1.4.0";
const UPLOADER = "flakiness@0.289.0";

type Environment = {
  name?: string;
  systemData?: { osName?: string; osVersion?: string; osArch?: string };
  metadata?: Record<string, unknown>;
};

type Report = { environments?: Environment[] };

/** Truncates `26.5.2` to `26.5`; passes an already-short `26.5` through unchanged. */
export function truncateToMajorMinor(version: string): string {
  const parts = version.split(".");
  if (parts.length < 2) {
    throw new Error(`unparseable macOS version ${JSON.stringify(version)} (expected at least major.minor)`);
  }
  return `${parts[0]}.${parts[1]}`;
}

export function normaliseReport(
  report: Report,
  platform: string = process.platform,
): { normalised: number; skipped: number } {
  const environments = report.environments ?? [];
  if (environments.length === 0) {
    throw new Error("report contains no environments — refusing to upload a report we cannot verify");
  }

  let normalised = 0;
  let skipped = 0;

  for (const env of environments) {
    const system = env.systemData;
    if (system?.osName?.toLowerCase() !== "macos") {
      skipped++;
      continue;
    }

    const original = system.osVersion;
    if (!original) {
      throw new Error(`macOS environment ${JSON.stringify(env.name ?? "?")} has no osVersion`);
    }

    system.osVersion = truncateToMajorMinor(original);
    // Truncation destroys ground truth, so keep the real string recoverable
    // without digging through GHA logs. Verified not to affect environment
    // identity — see check 3 in the design doc.
    env.metadata = { ...(env.metadata ?? {}), osVersionFull: original };
    normalised++;
  }

  // Every upload step runs with `continue-on-error: true`, so a silent no-op
  // here would look green while dropping the data it was meant to fix.
  for (const env of environments) {
    const system = env.systemData;
    if (system?.osName?.toLowerCase() !== "macos") continue;
    if (!MACOS_NORMALISED.test(system.osVersion ?? "")) {
      throw new Error(
        `macOS osVersion ${JSON.stringify(system.osVersion)} is not major.minor after normalisation — ` +
          `refusing to upload, as this would fragment environment history`,
      );
    }
  }

  // Otherwise the assert above passes vacuously should the converter rename osName.
  if (platform === "darwin" && normalised === 0) {
    throw new Error(
      `running on darwin but no environment was labelled "macos" — ` +
        `the converter's osName may have changed, which would silently defeat normalisation`,
    );
  }

  return { normalised, skipped };
}

async function run(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited ${code}`);
  }
}

async function main(): Promise<void> {
  const [junitPath, category, projectArg] = process.argv.slice(2);
  const project = projectArg ?? process.env.FLAKINESS_PROJECT;

  if (!junitPath || !category || !project) {
    throw new Error(
      "usage: upload-flakiness.ts <junit-path> <category> [project]\n" +
        "  project falls back to $FLAKINESS_PROJECT when omitted",
    );
  }

  if (!existsSync(junitPath)) {
    console.error(`No JUnit report at ${junitPath}; skipping Flakiness.io upload.`);
    return;
  }

  const outDir = mkdtempSync(join(tmpdir(), "flakiness-"));
  try {
    await run([
      "bunx",
      CONVERTER,
      junitPath,
      "--category",
      category,
      "--flakiness-project",
      project,
      "--disable-upload",
      "--output-dir",
      outDir,
    ]);

    const reportPath = join(outDir, "report.json");
    if (!existsSync(reportPath)) {
      throw new Error(`converter produced no report at ${reportPath}`);
    }

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
    const { normalised, skipped } = normaliseReport(report);
    writeFileSync(reportPath, JSON.stringify(report));
    console.error(`Normalised ${normalised} macOS environment(s), left ${skipped} untouched.`);

    await run(["bunx", UPLOADER, "upload", reportPath, "--project", project]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`Flakiness.io upload failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
