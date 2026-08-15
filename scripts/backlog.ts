#!/usr/bin/env bun
import { ExitCode, OperationalError, REPORT_SCHEMA_VERSION, acquireLease, bunRunner, claim, close, evaluateLeaseOperation, gate, leaseRoot, parseClaimManifest, parseGateEvidence, plan, releaseClaim, releaseLease, statusLease, sync, type Evaluation } from "./backlog-conveyor";

type Command =
  | { name: "sync"; apply: boolean; json: boolean }
  | { name: "gate"; issue: number; pr: number; evidencePath: string; apply: boolean; json: boolean }
  | { name: "close"; issue: number; pr: number; apply: boolean; json: boolean }
  | { name: "plan" | "claim" | "release"; manifestPath: string; apply: boolean; json: boolean }
  | { name: "lease"; operation: "acquire" | "release" | "status"; resource: string; holder?: string; ttlSeconds?: number; apply: boolean; json: boolean };

function usage(message: string): never {
  console.error(`${message}\nusage: bun run conveyor -- <sync|gate|close|plan|claim|release|lease> [--issue N --pr P] [--evidence path] [--manifest path] [--resource name --holder opaque --ttl-seconds N] [--apply] [--json]`);
  process.exit(ExitCode.operationalFailure);
}

function ttlSeconds(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) usage("--ttl-seconds requires a positive integer");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400) usage("--ttl-seconds must be between 1 and 86400");
  return parsed;
}

function issueNumber(flag: string, raw: string | undefined): number {
  if (!raw || !/^[1-9]\d*$/.test(raw)) usage(`${flag} requires a positive integer`);
  return Number(raw);
}

function parseArgs(argv: string[]): Command {
  const name = argv.shift();
  if (name !== "sync" && name !== "gate" && name !== "close" && name !== "plan" && name !== "claim" && name !== "release" && name !== "lease") usage(`unknown subcommand '${name ?? ""}'`);
  const operation = name === "lease" ? argv.shift() : undefined;
  if (name === "lease" && operation !== "acquire" && operation !== "release" && operation !== "status") usage("lease requires acquire, release, or status");
  let apply = false;
  let json = false;
  let issue: number | undefined;
  let pr: number | undefined;
  let evidencePath: string | undefined;
  let manifestPath: string | undefined;
  let resource: string | undefined;
  let holder: string | undefined;
  let leaseTtl: number | undefined;
  while (argv.length > 0) {
    const arg = argv.shift()!;
    if (arg === "--apply") apply = true;
    else if (arg === "--json") json = true;
    else if (arg === "--issue") issue = issueNumber(arg, argv.shift());
    else if (arg === "--pr") pr = issueNumber(arg, argv.shift());
    else if (arg === "--evidence") evidencePath = argv.shift() ?? usage("--evidence needs a path");
    else if (arg === "--manifest") manifestPath = argv.shift() ?? usage("--manifest needs a path");
    else if (arg === "--resource") resource = argv.shift() ?? usage("--resource needs a name");
    else if (arg === "--holder") holder = argv.shift() ?? usage("--holder needs an opaque value");
    else if (arg === "--ttl-seconds") leaseTtl = ttlSeconds(argv.shift());
    else usage(`unknown argument '${arg}'`);
  }
  if (name === "sync") {
    if (issue !== undefined || pr !== undefined || evidencePath !== undefined || manifestPath !== undefined || resource !== undefined || holder !== undefined || leaseTtl !== undefined) usage("sync does not accept command-specific flags");
    return { name, apply, json };
  }
  if (name === "plan" || name === "claim" || name === "release") {
    if (!manifestPath) usage(`${name} requires --manifest path`);
    if (issue !== undefined || pr !== undefined || evidencePath !== undefined || resource !== undefined || holder !== undefined || leaseTtl !== undefined) usage(`${name} only accepts --manifest, --apply, and --json`);
    if (name === "plan" && apply) usage("plan is read-only and does not accept --apply");
    return { name, manifestPath, apply, json };
  }
  if (name === "lease") {
    if (!resource) usage("lease requires --resource name");
    if (issue !== undefined || pr !== undefined || evidencePath !== undefined || manifestPath !== undefined) usage("lease does not accept issue, pull request, evidence, or manifest flags");
    if (operation === "status") {
      if (holder !== undefined || leaseTtl !== undefined || apply) usage("lease status accepts only --resource and --json");
      return { name, operation, resource, apply, json };
    }
    if (!holder) usage(`lease ${operation} requires --holder opaque`);
    if (operation === "release" && leaseTtl !== undefined) usage("lease release does not accept --ttl-seconds");
    return { name, operation, resource, holder, ttlSeconds: leaseTtl, apply, json };
  }
  if (issue === undefined || pr === undefined) usage(`${name} requires --issue N and --pr P`);
  if (name === "gate") {
    if (!evidencePath) usage("gate requires --evidence path");
    return { name, issue, pr, evidencePath, apply, json };
  }
  if (evidencePath !== undefined) usage("close does not accept --evidence");
  return { name, issue, pr, apply, json };
}

function exitCode(result: Evaluation): number {
  if (result.refusals.length > 0) return ExitCode.unsafeRefusal;
  if (result.violations.length > 0) return ExitCode.invariantViolation;
  return ExitCode.success;
}

function output(command: Command, result: Evaluation, details?: unknown): void {
  const report = { schemaVersion: REPORT_SCHEMA_VERSION, command: command.name, operation: command.name === "lease" ? command.operation : undefined, apply: command.apply, findings: result.findings, violations: result.violations, refusals: result.refusals, actions: result.safeActions };
  if (command.json) {
    console.log(JSON.stringify(details === undefined ? report : { ...report, details }));
    return;
  }
  console.log(`backlog ${command.name}: ${exitCode(result) === 0 ? "ok" : "blocked"}`);
  for (const message of [...result.findings, ...result.violations, ...result.refusals]) console.log(`- ${message}`);
  for (const action of result.safeActions) console.log(`- ${command.apply ? "applied" : "would apply"}: ${action.kind}`);
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  const runner = bunRunner();
  let result: Evaluation;
  if (command.name === "sync") result = await sync(runner, command.apply);
  else if (command.name === "gate") result = await gate(runner, command.issue, command.pr, parseGateEvidence(JSON.parse(await Bun.file(command.evidencePath).text()), `evidence ${command.evidencePath}`), command.apply);
  else if (command.name === "close") result = await close(runner, command.issue, command.pr, command.apply);
  else if (command.name === "plan") {
    const planned = await plan(runner, parseClaimManifest(JSON.parse(await Bun.file(command.manifestPath).text()), `manifest ${command.manifestPath}`));
    result = planned.evaluation;
    output(command, result, planned.plan);
    process.exit(exitCode(result));
  } else if (command.name === "claim") result = await claim(runner, parseClaimManifest(JSON.parse(await Bun.file(command.manifestPath).text()), `manifest ${command.manifestPath}`), command.apply);
  else if (command.name === "release") result = await releaseClaim(runner, parseClaimManifest(JSON.parse(await Bun.file(command.manifestPath).text()), `manifest ${command.manifestPath}`), command.apply);
  else {
    const root = await leaseRoot(runner);
    const preview = statusLease(root, command.resource);
    const decision = evaluateLeaseOperation(command.operation, { resource: command.resource, holder: command.holder }, preview);
    const shouldApply = command.apply && decision.safeActions.length === 1;
    const lease = !shouldApply ? preview : command.operation === "acquire"
      ? acquireLease(root, { resource: command.resource, holder: command.holder!, ttlSeconds: command.ttlSeconds })
      : releaseLease(root, { resource: command.resource, holder: command.holder! });
    result = shouldApply ? evaluateLeaseOperation(command.operation, { resource: command.resource, holder: command.holder }, lease) : decision;
    output(command, result, lease);
    process.exit(exitCode(result));
  }
  output(command, result);
  process.exit(exitCode(result));
}

try {
  if (import.meta.main) await main();
} catch (error) {
  const message = error instanceof OperationalError || error instanceof Error ? error.message : String(error);
  console.error(`backlog: ${message}`);
  process.exit(ExitCode.operationalFailure);
}
