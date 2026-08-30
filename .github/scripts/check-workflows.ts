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
const RUST_TOOLCHAIN_FILE = "rust-toolchain.toml";

export type RustToolchainPin = {
  channel: string;
  components: string[];
};

/** Read the source-controlled Rust toolchain contract shared by contributors and CI. */
export function readRustToolchainPin(): { pin?: RustToolchainPin; errors: string[] } {
  try {
    const contents = readFileSync(RUST_TOOLCHAIN_FILE, "utf8");
    const toolchain = /^\[toolchain\]\s*$([\s\S]*)/m.exec(contents)?.[1];
    if (!toolchain) return { errors: [`${RUST_TOOLCHAIN_FILE}: expected a [toolchain] table`] };

    const channel = /^channel\s*=\s*"([^"]+)"\s*$/m.exec(toolchain)?.[1];
    const componentList = /^components\s*=\s*\[([^\]]*)\]\s*$/m.exec(toolchain)?.[1] ?? "";
    const components = [...componentList.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");

    if (!channel) return { errors: [`${RUST_TOOLCHAIN_FILE}: expected [toolchain].channel`] };
    if (components.length === 0) return { errors: [`${RUST_TOOLCHAIN_FILE}: expected [toolchain].components`] };

    return { pin: { channel, components }, errors: [] };
  } catch (err) {
    return { errors: [`${RUST_TOOLCHAIN_FILE}: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/**
 * The action installs the toolchain passed through `with.toolchain`, rather than reading the
 * repository toolchain file. Keep every explicit action invocation aligned with that file.
 */
export function requirePinnedRustToolchain(path: string, document: unknown, pin: RustToolchainPin): string[] {
  const jobs = (document as { jobs?: Record<string, { steps?: unknown[] }> })?.jobs;
  if (!jobs || typeof jobs !== "object") return [];

  const errors: string[] = [];
  for (const [job, definition] of Object.entries(jobs)) {
    if (!Array.isArray(definition?.steps)) continue;
    for (const step of definition.steps as Step[]) {
      if (typeof step?.uses !== "string" || !step.uses.startsWith("dtolnay/rust-toolchain@")) continue;

      if (step.with?.toolchain !== pin.channel) {
        errors.push(`${path}: \`${job}\` must install Rust ${pin.channel}, not \`${String(step.with?.toolchain ?? "") }\``);
      }

      const components = String(step.with?.components ?? "")
        .split(",")
        .map((component) => component.trim())
        .filter(Boolean);
      const missing = pin.components.filter((component) => !components.includes(component));
      if (missing.length > 0) {
        errors.push(`${path}: \`${job}\` must install ${missing.join(", ")} from ${RUST_TOOLCHAIN_FILE}`);
      }
    }
  }
  return errors;
}

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
    if (!reference || reference.startsWith("./") || reference.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/i.test(reference)) {
      errors.push(`${path}: external action must be pinned to a full commit SHA: ${reference}`);
    }
  }

  return errors;
}

type Step = {
  name?: unknown;
  run?: unknown;
  uses?: unknown;
  if?: unknown;
  shell?: unknown;
  with?: { filters?: unknown } & Record<string, unknown>;
};

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
  const isAvspeech = (at: number) => /--voice\s+macos-/.test(String(steps[at]?.run));
  const avspeech = smokes.find(isAvspeech);
  const kokoro = smokes.some((at) => !isAvspeech(at));

  const errors: string[] = [];
  if (!kokoro) {
    errors.push(`${path}: \`${job}\` must synthesise through Kokoro — a smoke-synthesis.ts run on a non-\`macos-*\` voice (#678)`);
  }
  const avspeechStep = avspeech === undefined ? undefined : steps[avspeech];
  if (avspeechStep === undefined) {
    errors.push(`${path}: \`${job}\` must synthesise through the AVSpeech sidecar — a smoke-synthesis.ts run with \`--voice macos-*\` (#678)`);
    return errors;
  }
  if (/--text\b/.test(String(avspeechStep.run))) {
    errors.push(`${path}: \`${job}\`'s AVSpeech arm must carry the default pangram, not a \`--text\` override — it is the only long-utterance darwin coverage (#678)`);
  }
  if (!/!\s*cancelled\(\)/.test(condition(avspeechStep))) {
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

/**
 * Fails when a job that lands on a Windows runner leaves a `run:` step on the runner default.
 *
 * That default is pwsh, where a brace block fails loudly but `"$TARGET"` expands to the empty
 * string in silence — bash written into a pwsh step keeps running and reports success on nothing
 * (#849, #850). Cron-only workflows never execute in PR CI, so this file is the only lane that
 * sees them. An explicit `shell:` of any kind is a decision and passes; so does a `# pwsh-ok`
 * marker in the script, for the step that means the default.
 */
type Job = {
  "runs-on"?: unknown;
  "timeout-minutes"?: number;
  steps?: unknown[];
  strategy?: { matrix?: unknown };
  defaults?: { run?: { shell?: unknown } };
};

/** Every scalar reachable at `path`, descending into matrix lists on the way. */
function valuesAt(node: unknown, path: string[]): string[] {
  if (node === null || node === undefined) return [];
  if (Array.isArray(node)) return node.flatMap((item) => valuesAt(item, path));
  if (path.length === 0) return typeof node === "object" ? [] : [String(node)];
  if (typeof node !== "object") return [];
  return valuesAt((node as Record<string, unknown>)[path[0] ?? ""], path.slice(1));
}

/** The concrete labels a `runs-on` can resolve to, substituting the matrix keys it names. */
function runnerLabels(job: Job): string[] {
  const runsOn = job["runs-on"];
  const literals = [...valuesAt(runsOn, []), ...valuesAt((runsOn as { labels?: unknown })?.labels, [])];
  return literals.flatMap((label) => {
    const references = [...label.matchAll(/\$\{\{\s*matrix\.([\w.]+)\s*\}\}/g)];
    if (references.length === 0) return [label];
    const matrix = job.strategy?.matrix;
    return references.flatMap((reference) => {
      const key = (reference[1] ?? "").split(".");
      return [...valuesAt(matrix, key), ...valuesAt((matrix as { include?: unknown })?.include, key)];
    });
  });
}

export function requireBashOnWindowsRunSteps(path: string, document: unknown): string[] {
  const jobs = (document as { jobs?: Record<string, Job> })?.jobs;
  if (!jobs || typeof jobs !== "object") return [];

  const workflowShell = (document as { defaults?: { run?: { shell?: unknown } } })?.defaults?.run?.shell;
  const errors: string[] = [];

  for (const [name, job] of Object.entries(jobs)) {
    if (!Array.isArray(job?.steps)) continue;
    if (!runnerLabels(job).some((label) => /windows/i.test(label))) continue;
    if (typeof (job.defaults?.run?.shell ?? workflowShell) === "string") continue;

    for (const [at, step] of (job.steps as Step[]).entries()) {
      if (typeof step?.run !== "string" || typeof step.shell === "string") continue;
      if (/(^|\n)\s*#\s*pwsh-ok\b/.test(step.run)) continue;
      const label = typeof step.name === "string" ? `\`${step.name}\`` : `${at + 1}`;
      errors.push(
        `${path}: \`${name}\` step ${label} runs on windows without \`shell:\`; the default there is pwsh, where "$VAR" expands to empty in silence — set \`shell: bash\`, or \`# pwsh-ok\` in the script if it means pwsh (#850)`,
      );
    }
  }

  return errors;
}

/**
 * Fails when a `run:` step on a non-Windows runner resolves to a shell without pipefail.
 *
 * GitHub's *unspecified* default is `bash -e {0}`; only naming `bash` selects
 * `bash --noprofile --norc -eo pipefail {0}`. So an undeclared step takes its pipeline's **last**
 * stage exit status: `{ bun run check:versions; ... } | tee` recorded a failed check as ordinary
 * output and went green (#1083). `shell: sh` is the same trap spelled out, and so is `cmd`, which
 * exits with the last program's error level. An explicit non-POSIX shell has no pipelines to get
 * wrong and passes. Windows defaults to pwsh, which is `requireBashOnWindowsRunSteps`'s lane (#850).
 */
const PIPEFAIL_SHELLS = new Set(["bash", "pwsh", "powershell", "python"]);

export function requirePipefailShell(path: string, document: unknown): string[] {
  const jobs = (document as { jobs?: Record<string, Job> })?.jobs;
  if (!jobs || typeof jobs !== "object") return [];

  const workflowShell = (document as { defaults?: { run?: { shell?: unknown } } })?.defaults?.run?.shell;
  const errors: string[] = [];

  for (const [name, job] of Object.entries(jobs)) {
    if (!Array.isArray(job?.steps)) continue;
    const labels = runnerLabels(job);
    if (labels.length > 0 && labels.every((label) => /windows/i.test(label))) continue;

    for (const [at, step] of (job.steps as Step[]).entries()) {
      if (typeof step?.run !== "string") continue;
      const shell = step.shell ?? job.defaults?.run?.shell ?? workflowShell;
      if (typeof shell === "string" && PIPEFAIL_SHELLS.has(shell)) continue;
      const label = typeof step.name === "string" ? `\`${step.name}\`` : `${at + 1}`;
      const found =
        shell === undefined
          ? "has no `shell:`, so it runs under the unspecified default `bash -e {0}`"
          : `sets \`shell: ${String(shell)}\``;
      errors.push(
        `${path}: \`${name}\` step ${label} ${found} — no pipefail there, so a pipeline reports ` +
          `only its last stage and a failed command inside one passes silently. Name \`shell: bash\`, ` +
          `or set \`defaults.run.shell: bash\` once for the workflow (#1084)`,
      );
    }
  }

  return errors;
}

/**
 * Fails when a `run:` step pipes `find` into `head`. Both of these steps carry `shell: bash`,
 * which GitHub runs as `bash --noprofile --norc -eo pipefail {0}` — under pipefail, if `find` is
 * still writing when `head` has read enough lines and exits, `find` takes SIGPIPE and exits 141,
 * and `-e` fails the step on a traversal that actually succeeded. Whether it fires depends on how
 * many matches the tree produces and when, so it is a race that has simply not lost yet, not a
 * safe pattern (#1088). `find ... -print -quit` returns the same first match with no second
 * process and nothing to signal.
 */
export function forbidFindPipedToHead(path: string, contents: string): string[] {
  const errors: string[] = [];
  contents.split("\n").forEach((line, at) => {
    if (/^\s*#/.test(line)) return;
    if (!/\bfind\b/.test(line) || !/\|\s*head\b/.test(line)) return;
    errors.push(
      `${path}:${at + 1}: pipes \`find\` into \`head\` — under pipefail that is a SIGPIPE race (\`find\` can exit ` +
        `141 while still traversing), not a guaranteed success; use \`find ... -print -quit\` instead (#1088)`,
    );
  });
  return errors;
}

/**
 * Fails when a restore-only model cache has no writer, or has one that disagrees about the entry.
 *
 * `cache-write: "false"` hands the whole responsibility for an entry to cache-seed.yml (#661). Nothing
 * connected the two halves, so `macOS-kesha-models-tts-v1` was restored by the release-gating darwin
 * smoke for months while no job ever wrote it — a silent cold download, not a failure (#877). The path
 * set and archive mode are compared too: a reader whose path set differs from the writer's misses every
 * time and looks exactly the same from the outside (#860).
 */
type CacheEntry = { key: string; paths: string[]; crossOs: boolean };

const cachePaths = (value: unknown): string[] =>
  String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const describeEntry = (entry: CacheEntry) =>
  `path ${JSON.stringify(entry.paths)}${entry.crossOs ? " (cross-OS)" : ""}`;

/** Every exact key cache-seed.yml saves, with the path set and archive mode it saves under. */
export function collectCacheWriters(document: unknown): CacheEntry[] {
  const jobs = (document as { jobs?: Record<string, { steps?: unknown[] }> })?.jobs ?? {};
  return Object.values(jobs).flatMap((job) =>
    (Array.isArray(job?.steps) ? (job.steps as Step[]) : [])
      .filter((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/cache/save"))
      .map((step) => ({
        key: String(step.with?.key ?? ""),
        paths: cachePaths(step.with?.path),
        crossOs: String(step.with?.enableCrossOsArchive ?? false) === "true",
      })),
  );
}

export function requireRestoreOnlyCachesHaveAWriter(
  path: string,
  document: unknown,
  writers: CacheEntry[],
): string[] {
  const jobs = (document as { jobs?: Record<string, { steps?: unknown[] }> })?.jobs;
  if (!jobs || typeof jobs !== "object") return [];

  const errors: string[] = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (!Array.isArray(job?.steps)) continue;
    for (const step of job.steps as Step[]) {
      if (step?.uses !== "./.github/actions/install-kesha-backend") continue;
      if (String(step.with?.["cache-write"] ?? "true") !== "false") continue;

      const reader: CacheEntry = {
        key: String(step.with?.["cache-key"] ?? ""),
        paths: cachePaths(step.with?.["cache-path"]),
        crossOs: String(step.with?.["cache-cross-os"] ?? false) === "true",
      };
      const writer = writers.find((entry) => entry.key === reader.key);
      if (!writer) {
        errors.push(
          `${path}: \`${name}\` restores \`${reader.key}\` with cache-write false, but no cache-seed.yml job saves that key — it can only ever cold-download (#877)`,
        );
        continue;
      }
      if (
        writer.paths.join("\n") !== reader.paths.join("\n") ||
        writer.crossOs !== reader.crossOs
      ) {
        errors.push(
          `${path}: \`${name}\` restores \`${reader.key}\` at ${describeEntry(reader)}, but cache-seed.yml saves it at ${describeEntry(writer)}; a restore that disagrees with its writer never hits (#877)`,
        );
      }
    }
  }

  return errors;
}

/** The concrete `timeout-minutes` values a job's declaration resolves to, substituting matrix keys. */
function timeoutCandidates(job: Job): string[] {
  const raw = String(job["timeout-minutes"]);
  const references = [...raw.matchAll(/\$\{\{\s*matrix\.([\w.]+)\s*\}\}/g)];
  if (references.length === 0) return [raw];
  const matrix = job.strategy?.matrix;
  return references.flatMap((reference) => {
    const key = (reference[1] ?? "").split(".");
    return [...valuesAt(matrix, key), ...valuesAt((matrix as { include?: unknown })?.include, key)];
  });
}

/**
 * Fails when a job with its own steps has no `timeout-minutes`, or resolves to a value ≥360.
 * Generalises the apt-get-only, rust-test.yml-only rule #1090 added — the risk was never
 * apt-specific, and a macOS hang costs 10.3x an Ubuntu one (#1105).
 */
export function requireJobTimeouts(path: string, document: unknown): string[] {
  const jobs = (document as { jobs?: Record<string, Job> })?.jobs;
  if (!jobs || typeof jobs !== "object") return [];

  const errors: string[] = [];
  for (const [name, job] of Object.entries(jobs)) {
    // A reusable-workflow-call job (`uses:`) never has `steps` — GitHub's schema is one or
    // the other — so this already excludes it without a separate `uses` check.
    if (!Array.isArray(job?.steps)) continue;

    if (job["timeout-minutes"] == null) {
      errors.push(
        `${path}: \`${name}\` has no \`timeout-minutes\`; an unattended stall burns GitHub's 360-minute default (#1105)`,
      );
      continue;
    }

    for (const candidate of timeoutCandidates(job)) {
      const timeoutNum = Number(candidate);
      if (isNaN(timeoutNum) || timeoutNum >= 360) {
        errors.push(
          `${path}: \`${name}\` sets \`timeout-minutes: ${candidate}\`, not strictly below 360; an unattended stall still exceeds this bound (#1105)`,
        );
      }
    }
  }

  return errors;
}

/**
 * Fails when a script covered by a unit test sits outside ci.yml's `code` filter.
 * `check:versions` and the unit tests run inside `unit-tests`, which that filter gates,
 * so an uncovered script means edits to a gate skip the tests that prove it works.
 */
/**
 * A job that runs `bun test` without installing dependencies first passes until a test reaches
 * for one — `tests/helpers/repo.ts` importing `yaml` broke the alpha lane's derivation gate long
 * after the step was written, and only on the runs that actually cut an alpha (#993).
 */
export function requireDepsBeforeBunTest(path: string, document: unknown): string[] {
  const jobs = (document as { jobs?: Record<string, Job> })?.jobs;
  if (!jobs || typeof jobs !== "object") return [];

  const installs = (step: Step) =>
    (typeof step?.run === "string" && /\bbun install\b/.test(step.run)) ||
    (typeof step?.uses === "string" && step.uses.endsWith("/actions/setup-bun"));

  const errors: string[] = [];
  for (const [name, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? (job.steps as Step[]) : [];
    let installed = false;
    for (const step of steps) {
      if (installs(step)) installed = true;
      else if (!installed && runsMatching([step], /^\s*bun (test|run test)\b/m).length > 0) {
        errors.push(`${path}: job \`${name}\` runs \`bun test\` without installing dependencies first`);
        break;
      }
    }
  }
  return errors;
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
      const name = match[1];
      if (!name) continue;
      for (const candidate of [name, `${name}.ts`]) {
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

const PERMISSION_RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
const LEVEL_NAME = ["none", "read", "write"] as const;

/** GitHub grants a called workflow only what the calling job holds; a job-level block replaces the workflow-level one. */
function permissionGrants(node: unknown): Record<string, number> | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string") return { "*": node === "write-all" ? 2 : node === "read-all" ? 1 : 0 };
  if (typeof node !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [scope, value] of Object.entries(node as Record<string, unknown>)) {
    out[scope] = PERMISSION_RANK[String(value)] ?? 0;
  }
  return out;
}

function grantedTo(scope: string, grants: Record<string, number> | undefined): number {
  if (!grants) return 0;
  return grants[scope] ?? grants["*"] ?? 0;
}

export function requireReusableCallPermissions(path: string, document: unknown): string[] {
  const doc = document as { jobs?: Record<string, Job>; permissions?: unknown } | undefined;
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") return [];

  const workflowGrants = permissionGrants(doc?.permissions);
  const errors: string[] = [];

  for (const [name, job] of Object.entries(jobs)) {
    const uses = (job as { uses?: unknown })?.uses;
    if (typeof uses !== "string" || !uses.startsWith("./.github/workflows/")) continue;

    const calleePath = uses.slice(2);
    if (!existsSync(calleePath)) {
      errors.push(`${path}: \`${name}\` calls ${uses}, which does not exist`);
      continue;
    }

    const callee = parse(readFileSync(calleePath, "utf8")) as
      | { jobs?: Record<string, Job>; permissions?: unknown }
      | undefined;
    const calleeDefaults = permissionGrants(callee?.permissions);
    const granted = permissionGrants((job as { permissions?: unknown })?.permissions) ?? workflowGrants;

    for (const [calleeJob, nested] of Object.entries(callee?.jobs ?? {})) {
      const wanted = permissionGrants((nested as { permissions?: unknown })?.permissions) ?? calleeDefaults;
      if (!wanted) continue;
      for (const [scope, level] of Object.entries(wanted)) {
        if (scope === "*" || level <= grantedTo(scope, granted)) continue;
        errors.push(
          `${path}: \`${name}\` calls ${uses} whose job \`${calleeJob}\` requests \`${scope}: ${LEVEL_NAME[level]}\`, ` +
            `but the calling job only grants \`${scope}: ${LEVEL_NAME[grantedTo(scope, granted)]}\`. ` +
            `GitHub validates this before any \`if:\` runs, so the whole workflow fails to start`,
        );
      }
    }
  }
  return errors;
}

/**
 * The trigger names an `on:` declares, across all three forms GitHub accepts: `on: push`,
 * `on: [push, pull_request]`, and the mapping. `on` itself parses as the string key rather
 * than the YAML 1.1 boolean, and a mapping's `pull_request:` may carry a null body.
 */
function triggerNames(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((entry): entry is string => typeof entry === "string");
  if (typeof on === "object" && on !== null) return Object.keys(on);
  return [];
}

/**
 * Contexts that take a distinct value per ref. `github.head_ref` is deliberately absent: it is
 * empty on push events, so a group keyed on it alone collapses every push into one lane.
 */
const PER_REF_CONTEXT = /github\.ref(?!\w)/;
const EXPRESSION = /\$\{\{(.*?)\}\}/gs;
/** Single quotes with `''` escaping are GitHub's only string literal; `"…"` is invalid syntax, stripped so a typo cannot satisfy the check either. */
const STRING_LITERAL = /'(?:[^']|'')*'|"[^"]*"/g;

/**
 * Whether the group takes a distinct value per ref, which is the property that makes
 * cancellation safe. Necessary, not sufficient: it proves an expression *consumes* a per-ref
 * context as data, not that the result is injective over refs — `${{ github.ref == 'x' }}`
 * satisfies it and yields two groups. Deciding that needs an expression evaluator, so the
 * residual is stated rather than chased (#1105).
 */
function groupVariesPerRef(group: string): boolean {
  for (const [, expression] of group.matchAll(EXPRESSION)) {
    if (PER_REF_CONTEXT.test((expression ?? "").replace(STRING_LITERAL, ""))) return true;
  }
  return false;
}

/**
 * Fails when a workflow that runs on pull requests declares no top-level `concurrency` group.
 *
 * Without one every superseded push runs to completion: `rust-test.yml` carried two macOS
 * jobs that way, and macOS is 80% of this repo's CI cost at 10.3x Linux per minute (#1105).
 * The group must additionally vary per ref — any group shared across pull requests serialises
 * them into one queue, and GitHub evicts the pending run when a third arrives, so the evicted
 * run reports nothing and the required check never lands, blocking the PR forever (#597).
 */
export function requireConcurrencyOnPullRequestWorkflows(path: string, document: unknown): string[] {
  const doc = document as { on?: unknown; concurrency?: unknown } | undefined;
  if (!triggerNames(doc?.on).includes("pull_request")) return [];

  const concurrency = doc?.concurrency;
  if (concurrency === undefined || concurrency === null) {
    return [
      `${path}: runs on pull requests but declares no top-level \`concurrency\`; every superseded push runs the whole workflow to completion (#1105)`,
    ];
  }

  const group = typeof concurrency === "string" ? concurrency : (concurrency as { group?: unknown })?.group;
  if (typeof group !== "string" || !groupVariesPerRef(group)) {
    return [
      `${path}: \`concurrency.group\` must vary per ref — some \`\${{ }}\` expression has to use \`github.ref\` as an operand, not as quoted text; a group shared across pull requests queues them into one lane and GitHub evicts the pending run, so the required check never lands (#597)`,
    ];
  }
  return [];
}

/**
 * Fails when `rust-test.yml` stops cancelling superseded runs.
 *
 * Scoped to this one workflow rather than every pull-request workflow: `security.yml` sets
 * `cancel-in-progress: false` deliberately, and auditing that choice is outside #1105. Here
 * the line is the entire saving — two macOS jobs at 10.3x Linux per minute.
 */
export function requireRustTestCancelsSupersededRuns(path: string, document: unknown): string[] {
  if (!path.endsWith("rust-test.yml")) return [];

  const concurrency = (document as { concurrency?: unknown } | undefined)?.concurrency;
  const cancel = (concurrency as { "cancel-in-progress"?: unknown } | undefined)?.["cancel-in-progress"];
  if (cancel === true) return [];

  return [
    `${path}: \`concurrency.cancel-in-progress\` must be \`true\`; without it superseded pushes run both macOS jobs to completion, which is the entire cost saving (#1105)`,
  ];
}

const BUILD_ENGINE_GROUP = "${{ github.workflow }}-${{ github.ref }}";

/**
 * Fails when `build-engine.yml` stops serialising runs that share a ref.
 *
 * A tag ref is not single-use: `refs/tags/v1.0.1` carried three `push` runs at three different
 * head SHAs, because delete-and-re-push is how a failed release tag is retried here. Two in
 * flight together put two `release` jobs against one draft release, and a release published
 * short a platform binary needs a new patch tag to repair.
 *
 * The group is pinned to its exact text rather than checked with `groupVariesPerRef`, whose
 * stated residual would accept both a boolean that collapses every ref but one into a single
 * lane and a run-scoped group that serialises nothing — both mention `github.ref`. Changing
 * the group means changing this constant and saying why (#1108).
 */
export function requireBuildEngineSerialisesRunsPerRef(path: string, document: unknown): string[] {
  if (!path.endsWith("build-engine.yml")) return [];

  const concurrency = (document as { concurrency?: unknown } | undefined)?.concurrency;
  const group = typeof concurrency === "string" ? concurrency : (concurrency as { group?: unknown } | undefined)?.group;
  const errors: string[] = [];

  if (group !== BUILD_ENGINE_GROUP) {
    errors.push(
      `${path}: \`concurrency.group\` must be exactly \`${BUILD_ENGINE_GROUP}\`, not \`${String(group)}\`; a coarser group queues unrelated refs into one lane and a finer one serialises nothing, and both can still mention \`github.ref\`. Changing it deliberately means changing this rule and saying why (#1108)`,
    );
  }

  if ((concurrency as { "cancel-in-progress"?: unknown } | undefined)?.["cancel-in-progress"] !== false) {
    errors.push(
      `${path}: \`concurrency.cancel-in-progress\` must be spelled \`false\`; cancelling a superseded run mid-upload leaves the draft release short an asset, and a release name cannot be reused to repair it (#1108)`,
    );
  }

  return errors;
}

/**
 * Fails when the `ci` aggregator needs `nix-build`.
 *
 * A job in the required `ci` aggregator that cannot run on a pull request reds `main` — on
 * `cancelled` as well as `failure` (the `ci` aggregator's fail step) — with nothing a PR could have prevented.
 * Asserted as this one instance because a general matcher's own failure mode is an over-fire
 * and `check:workflows` is in `preflight`, so over-firing blocks every push; it therefore
 * misses the same job under another name. Widen on the second instance (#1105).
 */
export function forbidNixBuildInCiAggregator(path: string, document: unknown): string[] {
  if (!path.endsWith("ci.yml")) return [];

  const needs = (document as { jobs?: { ci?: { needs?: unknown } } } | undefined)?.jobs?.ci?.needs;
  if (!Array.isArray(needs) || !needs.includes("nix-build")) return [];

  return [
    `${path}: \`ci\` needs \`nix-build\`, which runs only on push — it cannot report on a pull request, ` +
      `yet a failed or cancelled run reds the required check on \`main\` (#1105)`,
  ];
}

export function checkFile(
  path: string,
  testedScripts: string[],
  cacheWriters: CacheEntry[],
  rustToolchain: RustToolchainPin | undefined,
): string[] {
  try {
    const contents = readFileSync(path, "utf8");
    const document = parse(contents);
    return [
      ...requirePinnedActions(path, contents),
      ...requirePreUploadSynthesisSmoke(path, document),
      ...requireDarwinSmokeCoversBothEngines(path, document),
      ...forbidLinuxPackaging(path, contents),
      ...forbidFindPipedToHead(path, contents),
      ...requireNpmPublishAfterPackaging(path, document),
      ...requirePactVerificationCoversEveryTarget(path, document),
      ...requireBashOnWindowsRunSteps(path, document),
      ...requirePipefailShell(path, document),
      ...requireReusableCallPermissions(path, document),
      ...requireConcurrencyOnPullRequestWorkflows(path, document),
      ...requireRustTestCancelsSupersededRuns(path, document),
      ...requireBuildEngineSerialisesRunsPerRef(path, document),
      ...forbidNixBuildInCiAggregator(path, document),
      ...requireJobTimeouts(path, document),
      ...requireDepsBeforeBunTest(path, document),
      ...requireRestoreOnlyCachesHaveAWriter(path, document, cacheWriters),
      ...requireTestedScriptsInCodeFilter(path, document, testedScripts),
      ...(rustToolchain ? requirePinnedRustToolchain(path, document, rustToolchain) : []),
    ];
  } catch (err) {
    return [describeUnreadable(path, err)];
  }
}

const SEED_WORKFLOW = ".github/workflows/cache-seed.yml";
const FLAKE_NIX = "flake.nix";

/**
 * flake.nix stages the same `say-avspeech` sidecar as build-engine.yml's steps, under the same
 * `find | head` SIGPIPE race (#1088) — but it isn't YAML, so it can't go through `checkFile`'s
 * `parse(contents)`. `forbidFindPipedToHead` is plain-text already; run it here directly instead.
 */
export function checkFlakeNix(path: string): string[] {
  if (!existsSync(path)) return [];
  return forbidFindPipedToHead(path, readFileSync(path, "utf8"));
}

function main(): void {
  const files = dirs.flatMap((dir) => collectYamlFiles(dir)).sort();
  if (files.length === 0) {
    console.error(`no workflow or action files found in ${dirs.join(", ")}`);
    process.exit(1);
  }

  const testedScripts = collectTestedScripts();
  // A missing seed workflow leaves every restore-only lane unwritten, which is the failure to report.
  const cacheWriters = existsSync(SEED_WORKFLOW)
    ? collectCacheWriters(parse(readFileSync(SEED_WORKFLOW, "utf8")))
    : [];
  const { pin: rustToolchain, errors: rustToolchainErrors } = readRustToolchainPin();
  const errors = [
    ...rustToolchainErrors,
    ...files.flatMap((path) => checkFile(path, testedScripts, cacheWriters, rustToolchain)),
    ...checkFlakeNix(FLAKE_NIX),
  ];
  for (const error of errors) console.error(error);

  if (errors.length > 0) {
    console.error(`\n${errors.length} workflow or action check(s) failed.`);
    process.exit(1);
  }
}

if (import.meta.main) main();
