#!/usr/bin/env bun
/**
 * Validate GitHub workflow and composite-action YAML plus immutable action refs.
 *
 * Replaces the ad-hoc `python3 -c "import yaml; yaml.safe_load(...)"` invocation
 * we were running before each workflow change. Same effect — surface syntax
 * errors locally before `git push` instead of finding them in CI — but uses
 * the bun toolchain so contributors don't need a python interpreter on PATH.
 *
 * Run via `bun run check:workflows`. Exits non-zero on syntax errors or mutable
 * action references; stays silent on success so it composes cleanly with other
 * pre-push checks.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, YAMLParseError } from "yaml";
import { engineTargetEntries, targetKey } from "../../src/engine-targets";

const dirs = [".github/workflows", ".github/actions"];

function collectYamlFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && /\.ya?ml$/.test(entry))
    .map((entry) => join(dir, entry));
}

function requirePinnedActions(path: string, contents: string): string[] {
  const errors: string[] = [];
  const actionPattern = /^\s*uses:\s+([^\s#]+)(?:\s+#.*)?$/gm;

  for (const match of contents.matchAll(actionPattern)) {
    const reference = match[1];
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/i.test(reference)) {
      errors.push(`${path}: external action must be pinned to a full commit SHA: ${reference}`);
    }
  }

  return errors;
}

type Step = { run?: unknown; uses?: unknown; if?: unknown; with?: { filters?: unknown } };

function jobSteps(document: unknown, job: string): Step[] | undefined {
  const steps = (document as { jobs?: Record<string, { steps?: unknown[] }> })?.jobs?.[job]?.steps;
  return Array.isArray(steps) ? (steps as Step[]) : undefined;
}

const condition = (step: Step) => String(step.if ?? "");

/** Indices of the steps whose `run` matches, skipping any switched off with `if: false`. */
function runsMatching(steps: Step[], pattern: RegExp): number[] {
  return steps.flatMap((step, at) =>
    typeof step?.run === "string" && pattern.test(step.run) && condition(step).trim() !== "false" ? [at] : [],
  );
}

/**
 * Fails when build-engine.yml's build job would upload an artifact it never synthesised with.
 * That workflow runs on releases only, so this is the one lane a PR can hold it to (#671).
 */
export function requirePreUploadSynthesisSmoke(path: string, document: unknown): string[] {
  if (!path.endsWith("build-engine.yml")) return [];

  const steps = jobSteps(document, "build");
  if (!steps) return [`${path}: expected a \`build\` job with steps`];

  // Anchored at line start so a commented-out or echoed mention doesn't satisfy the guard.
  const smoke = runsMatching(steps, /^\s*bun\s+\S*smoke-synthesis\.ts\b/m)[0];
  const upload = steps.findIndex((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/upload-artifact"));

  if (smoke === undefined) {
    return [`${path}: the build job must run smoke-synthesis.ts before uploading the artifact (#671)`];
  }
  if (upload === -1) {
    return [`${path}: the build job must upload the engine artifact after smoke-synthesis.ts (#671)`];
  }
  if (smoke > upload) {
    return [`${path}: smoke-synthesis.ts runs after the artifact is uploaded; move it before (#671)`];
  }
  return [];
}

/**
 * Fails when the darwin smoke lane stops covering both of the engines a macOS build ships.
 * They fail independently — Kokoro is CoreML in-process, AVSpeech is the Swift sidecar — and the
 * lane downloaded `say-avspeech-darwin-arm64` for a year without ever routing through it (#678).
 * The Kokoro arm carries the shorter sentence a runner's CPU CoreML survives (#742); AVSpeech,
 * which needs no accelerator, carries the full one.
 */
export function requireDarwinSmokeCoversBothEngines(path: string, document: unknown): string[] {
  if (!path.endsWith("build-engine.yml")) return [];

  const job = "darwin-synthesis-smoke";
  const steps = jobSteps(document, job);
  if (!steps) return [`${path}: expected a \`${job}\` job with steps`];

  const smokes = runsMatching(steps, /^\s*bun\s+\S*smoke-synthesis\.ts\b/m);
  const isAvspeech = (at: number) => /--voice\s+macos-/.test(String(steps[at].run));
  const avspeech = smokes.find(isAvspeech);
  const kokoro = smokes.some((at) => !isAvspeech(at));

  const errors: string[] = [];
  if (!kokoro) {
    errors.push(`${path}: \`${job}\` must synthesise through Kokoro — a smoke-synthesis.ts run on a non-\`macos-*\` voice (#678)`);
  }
  if (avspeech === undefined) {
    errors.push(`${path}: \`${job}\` must synthesise through the AVSpeech sidecar — a smoke-synthesis.ts run with \`--voice macos-*\` (#678)`);
    return errors;
  }
  if (/--text\b/.test(String(steps[avspeech].run))) {
    errors.push(`${path}: \`${job}\`'s AVSpeech arm must carry the default pangram, not a \`--text\` override — it is the only long-utterance darwin coverage (#678)`);
  }
  if (!/!\s*cancelled\(\)/.test(condition(steps[avspeech]))) {
    errors.push(`${path}: \`${job}\`'s AVSpeech arm needs \`if: \${{ !cancelled() }}\`, or a red Kokoro arm hides whether the sidecar works (#678)`);
  }
  return errors;
}

/**
 * Fails when build-engine.yml mentions Linux packaging at all. The `.deb`/`.rpm` carry
 * `package.json#version`, which `main` holds ahead of npm since #691, so a stable engine tag can
 * never name them after a published CLI — the gate that checked this made engine releases
 * unreleasable instead. They ship from release-cli.yml, on the tag that publishes the same
 * version to npm (#728). Matched against the raw file, not the parsed steps: `nfpm package`
 * or `cp dist/*.deb` reintroduces publishing without ever naming the old script.
 */
const PACKAGING_TOKENS = ["build-linux-packages", "linux-packages", "nfpm", ".deb", ".rpm"];

export function forbidLinuxPackaging(path: string, contents: string): string[] {
  if (!path.endsWith("build-engine.yml")) return [];

  // Comment lines are prose about the policy, not a step that ships a package.
  const code = contents
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  return PACKAGING_TOKENS.filter((token) => code.includes(token)).map(
    (token) =>
      `${path}: mentions \`${token}\`; Linux packages ship from release-cli.yml, which publishes npm in the same run (#728)`,
  );
}

/**
 * Fails when release-cli.yml could publish Linux packages without publishing the same version
 * to npm in the same run. A `.deb` names `package.json#version` and npm is the only thing that
 * makes that version real; the assertion that used to hold them together is gone (#727, #728).
 *
 * Both halves have to be real: `needs:` ordering alone is satisfied by a `packages` job that
 * builds and publishes nothing, so the job's own two steps are required as well.
 */
const usesAction = (steps: Step[], action: string) =>
  steps.some((step) => typeof step?.uses === "string" && step.uses === action);

const runsScript = (steps: Step[], script: string) =>
  runsMatching(steps, new RegExp(script.replace(/\./g, "\\."))).length > 0;

/** `needs:` is a string when it names one job, a list when it names several. */
function dependsOn(document: unknown, job: string, dependency: string): boolean {
  const needs = (document as { jobs?: Record<string, { needs?: unknown }> })?.jobs?.[job]?.needs;
  return [needs].flat().includes(dependency);
}

function requirePackagingJob(path: string, document: unknown): string[] {
  const steps = jobSteps(document, "packages");
  if (!steps) return [`${path}: expected a \`packages\` job with steps`];
  if (!usesAction(steps, "./.github/actions/linux-packages")) {
    return [`${path}: \`packages\` must build through ./.github/actions/linux-packages, the composite the CI lane shares (#728)`];
  }
  if (!runsScript(steps, "publish-cli-release.sh")) {
    return [`${path}: \`packages\` must run publish-cli-release.sh — it is what attaches the packages to the release (#728)`];
  }
  return [];
}

function requireNpmDispatchJob(path: string, document: unknown): string[] {
  const steps = jobSteps(document, "publish-npm");
  if (!steps) return [`${path}: expected a \`publish-npm\` job with steps`];
  if (!dependsOn(document, "publish-npm", "packages")) {
    return [`${path}: \`publish-npm\` must \`needs: packages\`, so no .deb is published without the npm publish it names (#728)`];
  }
  if (!runsScript(steps, "dispatch-npm-publish.sh")) {
    return [`${path}: \`publish-npm\` must run dispatch-npm-publish.sh — npm trusts one entry workflow (#731)`];
  }
  return [];
}

export function requireNpmPublishAfterPackaging(path: string, document: unknown): string[] {
  if (!path.endsWith("release-cli.yml")) return [];

  const tags = (document as { on?: { push?: { tags?: unknown } } })?.on?.push?.tags;
  if (!Array.isArray(tags) || !tags.includes("v*-cli")) {
    return [`${path}: must trigger on \`v*-cli\` tag pushes (#728)`];
  }

  return [...requirePackagingJob(path, document), ...requireNpmDispatchJob(path, document)];
}

/**
 * Fails when a script covered by a unit test sits outside ci.yml's `code` filter.
 * `check:versions` and the unit tests run inside `unit-tests`, which that filter gates,
 * so an uncovered script means edits to a gate skip the tests that prove it works.
 */
/**
 * Fails when a script covered by a unit test sits outside ci.yml's `code` filter.
 * `check:versions` and the unit tests run inside `unit-tests`, which that filter gates,
 * so an uncovered script means edits to a gate skip the tests that prove it works.
 */
/**
 * Fails when a published engine target has no runner verifying its capability pact.
 *
 * The per-PR pact tests are only sound while the recordings still match the binaries, and
 * a pact nothing re-derives rots into a false green. A target absent from this matrix keeps
 * its committed pact and loses the only thing checking it, which is the failure mode #798
 * exists to prevent — so adding a platform to `src/engine-targets.ts` must add a row here.
 */
export function requirePactVerificationCoversEveryTarget(path: string, document: unknown): string[] {
  if (!path.endsWith("capability-pact.yml")) return [];

  const include = (document as { jobs?: { pact?: { strategy?: { matrix?: { include?: unknown } } } } })
    ?.jobs?.pact?.strategy?.matrix?.include;
  if (!Array.isArray(include)) return [`${path}: expected a \`pact\` job with a \`strategy.matrix.include\` list`];

  const covered = new Set(include.map((row) => String((row as { target?: unknown })?.target)));
  return engineTargetEntries()
    .map(({ platform, arch }) => targetKey(platform, arch))
    .filter((target) => !covered.has(target))
    .map((target) => `${path}: no runner verifies ${target}'s pact, so nothing would catch it drifting (#798)`);
}

export function requireTestedScriptsInCodeFilter(
  path: string,
  document: unknown,
  testedScripts: string[],
): string[] {
  if (!path.endsWith("ci.yml")) return [];

  const raw = jobSteps(document, "changes")?.find((step) => typeof step?.with?.filters === "string")?.with?.filters;
  if (typeof raw !== "string") return [`${path}: expected a \`changes\` job with inline paths-filter filters`];

  const code = (parse(raw) as Record<string, string[]>)?.code;
  if (!Array.isArray(code)) return [`${path}: paths-filter is missing a \`code\` list`];

  const covers = (file: string) =>
    code.some((pattern) => (pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : pattern === file));

  return testedScripts
    .filter((file) => !covers(file))
    .map((file) => `${path}: ${file} has a unit test but no matching path in the \`code\` filter, so edits to it skip that test`);
}

function collectTestedScripts(): string[] {
  const tests = readdirSync("tests/unit", { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".test.ts"))
    .map((entry) => readFileSync(join("tests/unit", entry), "utf8"));

  // A TS import drops the extension, a spawned script keeps it — so try both and keep what exists on disk.
  const found = new Set<string>();
  for (const contents of tests) {
    for (const match of contents.matchAll(/\.github\/scripts\/([\w.-]+)/g)) {
      for (const candidate of [match[1], `${match[1]}.ts`]) {
        const file = join(".github/scripts", candidate);
        if (existsSync(file)) found.add(file);
      }
    }
  }
  return [...found].sort();
}

function describeUnreadable(path: string, err: unknown): string {
  if (err instanceof YAMLParseError) {
    // Rendered line:col so editors can jump to the offending position.
    return `${path}:${err.linePos?.[0]?.line ?? "?"}:${err.linePos?.[0]?.col ?? "?"}: ${err.message}`;
  }
  return `${path}: ${err instanceof Error ? err.message : String(err)}`;
}

function checkFile(path: string, testedScripts: string[]): string[] {
  try {
    const contents = readFileSync(path, "utf8");
    const document = parse(contents);
    return [
      ...requirePinnedActions(path, contents),
      ...requirePreUploadSynthesisSmoke(path, document),
      ...requireDarwinSmokeCoversBothEngines(path, document),
      ...forbidLinuxPackaging(path, contents),
      ...requireNpmPublishAfterPackaging(path, document),
      ...requirePactVerificationCoversEveryTarget(path, document),
      ...requireTestedScriptsInCodeFilter(path, document, testedScripts),
    ];
  } catch (err) {
    return [describeUnreadable(path, err)];
  }
}

function main(): void {
  const files = dirs.flatMap((dir) => collectYamlFiles(dir)).sort();
  if (files.length === 0) {
    console.error(`no workflow or action files found in ${dirs.join(", ")}`);
    process.exit(1);
  }

  const testedScripts = collectTestedScripts();
  const errors = files.flatMap((path) => checkFile(path, testedScripts));
  for (const error of errors) console.error(error);

  if (errors.length > 0) {
    console.error(`\n${errors.length} workflow or action check(s) failed.`);
    process.exit(1);
  }
}

if (import.meta.main) main();
