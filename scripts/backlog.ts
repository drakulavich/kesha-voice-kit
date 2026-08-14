#!/usr/bin/env bun
import { ExitCode, OperationalError, bunRunner, close, gate, sync, type Evaluation } from "./backlog-conveyor";

type Command = { name: "sync"; apply: boolean; json: boolean } | { name: "gate" | "close"; issue: number; pr: number; apply: boolean; json: boolean };

function usage(message: string): never {
  console.error(`${message}\nusage: bun run backlog -- <sync|gate|close> [--issue N --pr P] [--apply] [--json]`);
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
  while (argv.length > 0) {
    const arg = argv.shift()!;
    if (arg === "--apply") apply = true;
    else if (arg === "--json") json = true;
    else if (arg === "--issue") issue = issueNumber(arg, argv.shift());
    else if (arg === "--pr") pr = issueNumber(arg, argv.shift());
    else usage(`unknown argument '${arg}'`);
  }
  if (name === "sync") {
    if (issue !== undefined || pr !== undefined) usage("sync does not accept --issue or --pr");
    return { name, apply, json };
  }
  if (issue === undefined || pr === undefined) usage(`${name} requires --issue N and --pr P`);
  return { name, issue, pr, apply, json };
}

function exitCode(result: Evaluation): number {
  if (result.refusals.length > 0) return ExitCode.unsafeRefusal;
  if (result.violations.length > 0) return ExitCode.invariantViolation;
  return ExitCode.success;
}

function output(command: Command, result: Evaluation): void {
  const report = { schemaVersion: 1, command: command.name, apply: command.apply, findings: result.findings, violations: result.violations, refusals: result.refusals, actions: result.safeActions };
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
  let result: Evaluation;
  if (command.name === "sync") result = await sync(runner, command.apply);
  else if (command.name === "gate") result = await gate(runner, command.issue, command.pr, command.apply);
  else result = await close(runner, command.issue, command.pr, command.apply);
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
