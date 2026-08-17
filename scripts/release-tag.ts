#!/usr/bin/env bun
/**
 * Create one stable, annotated engine tag from current origin/main.
 *
 * The API fallback deliberately creates an annotated Git tag object before its ref: GitHub's
 * REST API does not turn a tag object into a tag until `refs/tags/<tag>` is created.
 * Source: https://docs.github.com/en/rest/git/tags?apiVersion=2022-11-28#create-a-tag-object
 *         https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#create-a-reference
 */
import { readFile } from "node:fs/promises";

const REPO = "drakulavich/kesha-voice-kit";
const TAG = /^v\d+\.\d+\.\d+$/;

export type Mode = "push" | "api";
export type Options = { tag: string; notesPath: string; mode: Mode };
export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (argv: string[], input?: string) => Promise<CommandResult>;

function fail(message: string): never {
  throw new Error(`release-tag: ${message}`);
}

function requireSuccess(result: CommandResult, display: string): string {
  if (result.code !== 0) fail(`${display} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout.trim();
}

export function parseArgs(argv: string[]): Options {
  let tag = "";
  let notesPath = "";
  let mode: Mode = "push";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--tag") tag = value ?? "";
    else if (flag === "--notes") notesPath = value ?? "";
    else if (flag === "--mode") {
      if (value === "push" || value === "api") mode = value;
      else fail("--mode must be push or api");
    } else fail(`unknown argument ${flag}`);
    i++;
  }
  if (!TAG.test(tag)) fail("--tag must be a stable vX.Y.Z tag (no prerelease or -cli suffix)");
  if (!notesPath) fail("--notes must name the release-notes file");
  return { tag, notesPath, mode };
}

async function shell(runner: CommandRunner, ...argv: string[]): Promise<string> {
  return requireSuccess(await runner(argv), argv.join(" "));
}

async function remoteTagAbsent(runner: CommandRunner, tag: string): Promise<void> {
  const result = await runner(["gh", "api", `repos/${REPO}/git/ref/tags/${tag}`]);
  if (result.code === 0) fail(`remote tag ${tag} already exists; tags are one-use`);
  if (!/404|not found/i.test(result.stderr)) {
    fail(`could not prove remote tag ${tag} is absent${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
}

async function localTagAbsent(runner: CommandRunner, tag: string): Promise<void> {
  const result = await runner(["git", "show-ref", "--verify", "--quiet", `refs/tags/${tag}`]);
  if (result.code === 0) fail(`local tag ${tag} already exists; resolve its remote state before retrying`);
  if (result.code !== 1) fail(`could not inspect local tag ${tag}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

async function verifyRemoteTag(
  runner: CommandRunner,
  tag: string,
  target: string,
  notes: string,
  identity: { name: string; email: string },
): Promise<void> {
  const ref = parseJson<{ ref?: string; object?: { type?: string; sha?: string } }>(
    await shell(runner, "gh", "api", `repos/${REPO}/git/ref/tags/${tag}`),
    "tag reference",
  );
  if (ref.ref !== `refs/tags/${tag}` || ref.object?.type !== "tag" || !ref.object.sha) {
    fail(`remote ref for ${tag} is not an annotated tag object`);
  }
  const object = parseJson<{
    tag?: string;
    message?: string;
    object?: { type?: string; sha?: string };
    tagger?: { name?: string; email?: string };
  }>(await shell(runner, "gh", "api", `repos/${REPO}/git/tags/${ref.object.sha}`), "tag object");
  if (object.tag !== tag || object.message !== notes || object.object?.type !== "commit" || object.object.sha !== target) {
    fail(`remote annotated tag ${tag} does not match the requested target or notes`);
  }
  if (object.tagger?.name !== identity.name || object.tagger.email !== identity.email) {
    fail(`remote annotated tag ${tag} has an unexpected tagger identity`);
  }
}

async function waitForWorkflow(
  runner: CommandRunner,
  tag: string,
  target: string,
  event: "push" | "workflow_dispatch",
): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const raw = await shell(
      runner,
      "gh",
      "run",
      "list",
      "--repo",
      REPO,
      "--workflow",
      "build-engine.yml",
      "--branch",
      tag,
      "--limit",
      "10",
      "--json",
      "databaseId,headSha,event,url",
    );
    const runs = parseJson<Array<{ headSha?: string; event?: string }>>(raw, "workflow runs");
    if (runs.some((run) => run.headSha === target && run.event === event)) return;
    await Bun.sleep(2_000);
  }
  fail(`no ${event} build-engine workflow run appeared for ${tag} at ${target}`);
}

export async function createStableTag(options: Options, notes: string, runner: CommandRunner): Promise<void> {
  if (!notes.trim()) fail("release notes must not be empty");
  await shell(runner, "git", "fetch", "origin", "main");
  const target = await shell(runner, "git", "rev-parse", "origin/main");
  if (!/^[0-9a-f]{40}$/i.test(target)) fail("origin/main did not resolve to a commit SHA");
  if ((await shell(runner, "git", "status", "--porcelain")) !== "") fail("working tree is not clean");
  await remoteTagAbsent(runner, options.tag);
  await localTagAbsent(runner, options.tag);
  const identity = {
    name: await shell(runner, "git", "config", "user.name"),
    email: await shell(runner, "git", "config", "user.email"),
  };
  if (!identity.name || !identity.email) fail("git user.name and user.email must be configured");

  if (options.mode === "push") {
    await shell(runner, "git", "tag", "-a", options.tag, target, "--cleanup=verbatim", "-F", options.notesPath);
    const pushed = await runner(["git", "push", "origin", `refs/tags/${options.tag}`]);
    if (pushed.code !== 0) {
      fail(`standard tag push failed; remote state is uncertain, so API fallback was not attempted. Verify ${options.tag} remotely before retrying`);
    }
  } else {
    const tagObject = requireSuccess(
      await runner(
        ["gh", "api", "--method", "POST", `repos/${REPO}/git/tags`, "--input", "-"],
        JSON.stringify({ tag: options.tag, message: notes, object: target, type: "commit", tagger: { ...identity, date: new Date().toISOString() } }),
      ),
      "create annotated tag object",
    );
    const tagSha = parseJson<{ sha?: string }>(tagObject, "created tag object").sha;
    if (!tagSha || !/^[0-9a-f]{40}$/i.test(tagSha)) fail("GitHub did not return an annotated tag object SHA");
    await shell(runner, "gh", "api", "--method", "POST", `repos/${REPO}/git/refs`, "-f", `ref=refs/tags/${options.tag}`, "-f", `sha=${tagSha}`);
  }

  await verifyRemoteTag(runner, options.tag, target, notes, identity);
  if (options.mode === "api") {
    await shell(runner, "gh", "workflow", "run", "build-engine.yml", "--repo", REPO, "--ref", options.tag);
  }
  await waitForWorkflow(runner, options.tag, target, options.mode === "push" ? "push" : "workflow_dispatch");
  console.log(`Verified annotated tag ${options.tag} at ${target}; build-engine workflow was triggered.`);
}

async function run(argv: string[], input?: string): Promise<CommandResult> {
  const proc = Bun.spawn(argv, { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  if (input && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const notes = await readFile(options.notesPath, "utf8");
  await createStableTag(options, notes, run);
}
