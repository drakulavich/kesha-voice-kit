#!/usr/bin/env bun
import { ExitCode, OperationalError, REPORT_SCHEMA_VERSION, bunRunner, close, gate, parseGateEvidence, sync, type Evaluation } from "./backlog-conveyor";

type Command =
  | { name: "sync"; apply: boolean; json: boolean }
  | { name: "gate"; issue: number; pr: number; evidencePath: string; apply: boolean; json: boolean }
  | { name: "close"; issue: number; pr: number; apply: boolean; json: boolean };

function usage(message: string): never {
  console.error(`${message}\nusage: bun run conveyor -- <sync|gate|close> [--issue N --pr P] [--evidence path] [--apply] [--json]`);
  process.exit(ExitCode.operationalFailure);
}

function issueNumber(flag: string, raw: string | undefined): number {
  if (!raw || !/^[1-9]\d*$/.test(raw)) usage(`${flag} requires a positive integer`);
  return Number(raw);
}

function parseArgs(argv: string[]): Command {
  const name = argv.shift();
  if (name !== "sync" && name !== "gate" && name !== "close") usage(`unknown subcommand '${name ?? ""}'`);
  let apply = false;
  let json = false;
  let issue: number | undefined;
  let pr: number | undefined;
  let evidencePath: string | undefined;
  while (argv.length > 0) {
    const arg = argv.shift()!;
    if (arg === "--apply") apply = true;
    else if (arg === "--json") json = true;
    else if (arg === "--issue") issue = issueNumber(arg, argv.shift());
    else if (arg === "--pr") pr = issueNumber(arg, argv.shift());
    else if (arg === "--evidence") evidencePath = argv.shift() ?? usage("--evidence needs a path");
    else usage(`unknown argument '${arg}'`);
  }
  if (name === "sync") {
    if (issue !== undefined || pr !== undefined || evidencePath !== undefined) usage("sync does not accept command-specific flags");
    return { name, apply, json };
  }
  if (issue === undefined || pr === undefined) usage(`${name} requires --issue N and --pr P`);
  if (name === "gate") {
    if (!evidencePath) usage("gate requires --evidence path");
    return { name, issue, pr, evidencePath, apply, json };
  }
  if (evidencePath !== undefined) usage("close does not accept evidence flags");
  return { name, issue, pr, apply, json };
}

function exitCode(result: Evaluation): number {
  if (result.refusals.length > 0) return ExitCode.unsafeRefusal;
  if (result.violations.length > 0) return ExitCode.invariantViolation;
  return ExitCode.success;
}

function output(command: Command, result: Evaluation): void {
  const report = { schemaVersion: REPORT_SCHEMA_VERSION, command: command.name, apply: command.apply, findings: result.findings, violations: result.violations, refusals: result.refusals, actions: result.safeActions };
  if (command.json) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(`backlog ${command.name}: ${exitCode(result) === 0 ? "ok" : "blocked"}`);
  for (const message of [...result.findings, ...result.violations, ...result.refusals]) console.log(`- ${message}`);
  for (const action of result.safeActions) console.log(`- ${command.apply ? "applied" : "would apply"}: ${action.kind}`);
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  const runner = bunRunner();
  const result = command.name === "sync"
    ? await sync(runner, command.apply)
    : command.name === "gate"
      ? await gate(runner, command.issue, command.pr, parseGateEvidence(JSON.parse(await Bun.file(command.evidencePath).text()), `evidence ${command.evidencePath}`), command.apply)
      : await close(runner, command.issue, command.pr, command.apply);
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
