#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestGateEvidence, type GateEvidence } from "./backlog-conveyor";

export type EvidenceInput = { provider: string; headSha: string; uri: string };

/// Builds the SHA-bound evidence the conveyor gate verifies, through the gate's own digest
/// helper so the two cannot drift. `verdict` and `version` are literals by contract (#1078).
export function buildGateEvidence(input: EvidenceInput): GateEvidence {
  for (const [name, value] of Object.entries(input)) {
    if (!value) throw new Error(`${name} must be a non-empty string`);
  }
  if (!/^[0-9a-f]{40}$/.test(input.headSha)) throw new Error(`headSha must be a full 40-character SHA, got '${input.headSha}'`);
  const payload = { version: 1 as const, provider: input.provider, verdict: "APPROVED" as const, headSha: input.headSha, uri: input.uri };
  return { ...payload, digest: digestGateEvidence(payload) };
}

function usage(message: string): never {
  console.error(`${message}\nusage: bun scripts/gate-evidence.ts <provider> <uri> [--pr N]`);
  process.exit(2);
}

async function headSha(pr: string): Promise<string> {
  const proc = Bun.spawn(["gh", "pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid"], { stdout: "pipe", stderr: "pipe" });
  const sha = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !sha) throw new Error(`could not read the head SHA of pull request ${pr}`);
  return sha;
}

async function main(): Promise<void> {
  const [provider, uri, flag, pr] = process.argv.slice(2);
  if (!provider || !uri) usage("provider and uri are required");
  if (flag !== undefined && flag !== "--pr") usage(`unknown argument '${flag}'`);
  if (flag === "--pr" && !pr) usage("--pr needs a pull request number");
  // Read the head immediately before binding to it: a push between the two would otherwise
  // produce evidence for a superseded head, which is the staleness the digest exists to prevent.
  const evidence = buildGateEvidence({ provider, uri, headSha: await headSha(pr ?? "") });
  // A unique directory, because two lanes sharing one /tmp path already shipped a PR with
  // another PR's body (#1007).
  const path = join(mkdtempSync(join(tmpdir(), "kesha-gate-")), "evidence.json");
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(path);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`gate-evidence: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
