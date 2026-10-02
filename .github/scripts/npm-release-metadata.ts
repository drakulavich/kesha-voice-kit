#!/usr/bin/env bun
/**
 * Asserts the registry serves <package>@<version> with a sha512 integrity and SLSA v1 provenance.
 *
 * Usage: bun .github/scripts/npm-release-metadata.ts <package> <version>
 */
const SLSA_V1 = "https://slsa.dev/provenance/v1";

interface NpmView {
  version?: unknown;
  dist?: { integrity?: unknown; attestations?: { provenance?: { predicateType?: unknown } } };
}

export function assertNpmReleaseMetadata(raw: string, pkg: string, version: string, exitCode: number): { version: string; provenance: string } {
  const spec = `${pkg}@${version}`;
  if (exitCode !== 0) throw new Error(`${spec}: npm view exited ${exitCode}; the registry answer above is not trusted`);
  let doc: NpmView;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error(`${spec}: npm view printed no JSON (got ${JSON.stringify(raw.slice(0, 120))})`);
  }
  if (doc.version !== version) {
    throw new Error(`${spec}: registry serves version ${String(doc.version)}, expected ${version}`);
  }
  const integrity = doc.dist?.integrity;
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error(`${spec}: dist.integrity is not a sha512 digest (got ${JSON.stringify(integrity)})`);
  }
  const provenance = doc.dist?.attestations?.provenance?.predicateType;
  if (provenance !== SLSA_V1) {
    throw new Error(`${spec}: no ${SLSA_V1} provenance attestation (got ${JSON.stringify(provenance)})`);
  }
  return { version, provenance };
}

export type ViewResult = { stdout: string; exitCode: number };

export async function viewWhenPublished(view: () => ViewResult, attempts: number, waitMs: number): Promise<ViewResult> {
  let result = view();
  for (let i = 1; i < attempts && result.exitCode !== 0; i++) {
    await Bun.sleep(waitMs);
    result = view();
  }
  return result;
}

if (import.meta.main) {
  const [pkg, version] = process.argv.slice(2);
  if (!pkg || !version) {
    console.error("usage: npm-release-metadata.ts <package> <version>");
    process.exit(2);
  }
  // The whole document: a comma-joined field list makes npm print nothing at all (v1.29.1-cli, v1.30.0-cli lanes).
  const view = await viewWhenPublished(
    () => {
      const run = Bun.spawnSync(["npm", "view", `${pkg}@${version}`, "--json", "--prefer-online"], { stdout: "pipe", stderr: "inherit" });
      return { stdout: run.stdout.toString(), exitCode: run.exitCode ?? 1 };
    },
    20,
    30_000,
  );
  try {
    const { provenance } = assertNpmReleaseMetadata(view.stdout, pkg, version, view.exitCode);
    console.log(`ok: ${pkg}@${version} on the registry with ${provenance}`);
  } catch (e) {
    console.error(`::error::FAIL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
