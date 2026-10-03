import { describe, expect, test } from "bun:test";
import {
  commandLines,
  interpolatedParameters,
  isNpmSwept,
  isSwept,
  type JustDump,
  knownRecipeNames,
  npmGlobalCommands,
  npmSweptFiles,
  referencedRecipes,
  sweepErrors,
  sweptFiles,
  undocumentedRecipes,
  unguardedPipelines,
  unknownReferences,
} from "../../.github/scripts/check-recipes";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readRepoFile, REPO_ROOT } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";

const MD = "CLAUDE.md";
const YML = ".github/workflows/ci.yml";

const recipe = (doc: string | null, isPrivate = false) => ({ doc, private: isPrivate });
const dump = (
  recipes: NonNullable<JustDump["recipes"]>,
  aliases: Record<string, unknown> = {},
): JustDump => ({ recipes, aliases });

const names = (path: string, contents: string) => referencedRecipes(path, contents).map((r) => r.recipe);

describe("undocumentedRecipes", () => {
  test("passes when every recipe carries a doc comment", () => {
    expect(undocumentedRecipes(dump({ test: recipe("Run all tests") }))).toEqual([]);
  });

  test("fails when a recipe has no doc comment", () => {
    const errors = undocumentedRecipes(dump({ test: recipe("Run all tests"), lint: recipe(null) }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`lint` has no doc comment");
  });

  test("an empty comment is no comment", () => {
    expect(undocumentedRecipes(dump({ lint: recipe("") }))).toHaveLength(1);
  });

  // `just --list` hides private recipes, so a doc comment on one would never be read.
  test("private recipes are exempt", () => {
    expect(undocumentedRecipes(dump({ _stage: recipe(null, true) }))).toEqual([]);
  });
});

describe("knownRecipeNames", () => {
  test("collects recipes and the aliases that stand in for them", () => {
    const known = knownRecipeNames(dump({ "release-preflight": recipe("x") }, { release: {} }));
    expect([...known].sort()).toEqual(["release", "release-preflight"]);
  });
});

describe("referencedRecipes", () => {
  test("reads an inline code span", () => {
    expect(names(MD, "- `just preflight` before every push — the executable definition")).toEqual([
      "preflight",
    ]);
  });

  // The whole reason this gate parses contexts rather than text: "just" is an English adverb.
  test.each([
    "The Rust gate is just a clippy run over the darwin feature set.",
    "It will just inform you and stop; nothing else changed.",
    "Contributors who just want the binary can skip this section.",
  ])("ignores prose: %s", (line) => {
    expect(names(MD, line)).toEqual([]);
  });

  test("reads the variable-assignment form", () => {
    expect(names(MD, "`just ALL=1 preflight` runs every gate regardless of the diff")).toEqual([
      "preflight",
    ]);
  });

  test("reads several assignments before the recipe name", () => {
    expect(names(MD, "`just FILE=src/errors.rs ALL=1 preflight`")).toEqual(["preflight"]);
  });

  test("reads a fenced code block", () => {
    expect(names(MD, "```bash\njust smoke-test --tts\n```")).toEqual(["smoke-test"]);
  });

  test("stops reading at the closing fence", () => {
    expect(names(MD, "```bash\njust test\n```\nand then just carry on regardless")).toEqual(["test"]);
  });

  test("reads past a shell operator", () => {
    expect(names(MD, "```\nbun install && just check\n```")).toEqual(["check"]);
  });

  // A flag is not a recipe, and guessing at one would make `just --list` a phantom reference.
  test.each(["`just --list`", "`just --dump --dump-format json`", "`just -f other/justfile test`"])(
    "skips the flag form: %s",
    (span) => {
      expect(names(MD, span)).toEqual([]);
    },
  );

  test("reads a workflow's inline run: step", () => {
    expect(names(YML, "        run: just verify-darwin-full")).toEqual(["verify-darwin-full"]);
  });

  test("reads a workflow's block run: scalar", () => {
    const step = "      - name: Verify\n        run: |\n          bun install\n          just rust-test\n";
    expect(names(YML, step)).toEqual(["rust-test"]);
  });

  test("a block scalar ends where the indentation returns", () => {
    const job = "        run: |\n          just test\n        name: after\n      - run: just check\n";
    expect(names(YML, job)).toEqual(["test", "check"]);
  });

  test("ignores a workflow comment", () => {
    expect(names(YML, "      # just does not run on this lane, so the flags stay inline")).toEqual([]);
  });

  test("ignores YAML outside a run: scalar", () => {
    expect(names(YML, "        with:\n          tool: just@1.58.0")).toEqual([]);
  });

  test("reports where the reference sits", () => {
    const found = referencedRecipes(MD, "intro\n\n- `just preflight` before every push");
    expect(found).toEqual([{ line: 3, recipe: "preflight", text: "just preflight" }]);
  });
});

describe("commandLines", () => {
  test("a file type outside the swept extensions yields nothing", () => {
    expect(commandLines(".claude/hooks/guard.sh", "just test")).toEqual([]);
  });
});

describe("unknownReferences", () => {
  const known = new Set(["preflight", "verify-darwin-full"]);

  test("passes when every reference resolves", () => {
    expect(unknownReferences(MD, "`just preflight` then `just verify-darwin-full`", known)).toEqual([]);
  });

  test("fails on a reference to a recipe that does not exist", () => {
    const errors = unknownReferences(MD, "run `just verify-darwin` before pushing", known);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("CLAUDE.md:1:");
    expect(errors[0]).toContain("`just verify-darwin` names a recipe the justfile does not define");
  });
});

describe("isSwept", () => {
  test.each([
    "CLAUDE.md",
    "README.md",
    "CONTRIBUTING.md",
    "docs/architecture.md",
    ".claude/skills/release/SKILL.md",
    ".github/workflows/ci.yml",
  ])("sweeps %s", (path) => {
    expect(isSwept(path)).toBe(true);
  });

  // Historical records: they describe what was true when written, not what is true now.
  test.each([
    "docs/superpowers/specs/2026-05-30-lanes.md",
    "docs/plans/completed/2026-05-11-nix.md",
    "docs/mutation-evidence/issue-1105.md",
  ])(
    "excludes %s",
    (path) => {
      expect(isSwept(path)).toBe(false);
    },
  );

  test.each(["src/engine.ts", "justfile", ".claude/settings.json", "docs/assets/demo.webp"])(
    "ignores %s",
    (path) => {
      expect(isSwept(path)).toBe(false);
    },
  );
});

describe("sweptFiles", () => {
  const files = sweptFiles(REPO_ROOT);

  test("finds the files #797 names", () => {
    for (const path of ["CLAUDE.md", "docs/architecture.md"]) {
      expect(files).toContain(path);
    }
  });

  test("every swept file is one isSwept accepts", () => {
    expect(files.filter((path) => !isSwept(path))).toEqual([]);
  });
});

// `{{ slug }}` is substituted into the recipe text before the shell parses it, so a caller's
// metacharacters run: `just worktree 'x"; rm -rf ~; #'` executed the payload until #907.
describe("interpolatedParameters", () => {
  const withBody = (parameters: string[], body: unknown[]) => ({
    doc: "d",
    parameters: parameters.map((name) => ({ name })),
    body,
  });
  const addSlug = ['git worktree add ".worktrees/', [["variable", "slug"]], '"'];

  test("flags a parameter substituted into the recipe body", () => {
    const errors = interpolatedParameters(dump({ worktree: withBody(["slug"], [addSlug]) }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`worktree` interpolates {{ slug }}");
  });

  test("passes when the body binds the parameter positionally instead", () => {
    const positional = [['git worktree add ".worktrees/$1"']];
    expect(interpolatedParameters(dump({ worktree: withBody(["slug"], positional) }))).toEqual([]);
  });

  test("a justfile variable is not a parameter, so interpolating it is not this bug", () => {
    const body = [["kesha install ", [["variable", "TTS_FLAG"]]]];
    expect(interpolatedParameters(dump({ "smoke-test": withBody([], body) }))).toEqual([]);
  });

  test("finds an interpolation nested anywhere in the body", () => {
    const shebang = [["#!/usr/bin/env bash"], ["set -euo pipefail"], addSlug];
    expect(interpolatedParameters(dump({ worktree: withBody(["slug"], shebang) }))).toHaveLength(1);
  });

  test("names every offending parameter once, however often it appears", () => {
    const body = [addSlug, ["-b ", [["variable", "branch"]]], addSlug];
    const errors = interpolatedParameters(dump({ worktree: withBody(["slug", "branch"], body) }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("{{ branch }}, {{ slug }}");
  });
});

// A pipeline reports only its last stage's status, so `just worktree-rm x | tail && echo "removed"`
// printed `removed` for a worktree that was still there. `set -o pipefail` is what makes it honest.
describe("unguardedPipelines", () => {
  const shebang = (body: string[], isShebang = true) => ({
    doc: "d",
    shebang: isShebang,
    body: body.map((line) => [line]),
  });

  test("flags a pipeline that runs without pipefail", () => {
    const errors = unguardedPipelines(
      dump({ land: shebang(["#!/usr/bin/env bash", "set -eu", 'git log | head -3 && echo "ok"']) }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`land` runs a pipeline");
    expect(errors[0]).toContain("git log | head -3");
    expect(errors[0]).toContain("set -euo pipefail");
  });

  test("passes once pipefail is set above the pipeline", () => {
    const body = ["#!/usr/bin/env bash", "set -euo pipefail", "git log | head -3"];
    expect(unguardedPipelines(dump({ land: shebang(body) }))).toEqual([]);
  });

  test("the long form counts too", () => {
    const body = ["#!/usr/bin/env bash", "set -o pipefail", "git log | head -3"];
    expect(unguardedPipelines(dump({ land: shebang(body) }))).toEqual([]);
  });

  test("every spelling that really enables pipefail counts", () => {
    for (const set of ["set -euo pipefail", "set -o pipefail", "set -o errexit -o pipefail"]) {
      const body = ["#!/usr/bin/env bash", set, "git log | head -3"];
      expect(unguardedPipelines(dump({ land: shebang(body) }))).toEqual([]);
    }
  });

  // `set pipefail` makes "pipefail" a positional argument and `set -e pipefail` makes it $1.
  // Neither turns the option on, so neither may silence the gate.
  test("a `set` that does not enable pipefail does not guard anything", () => {
    for (const set of ["set pipefail", "set -- pipefail", "set -e pipefail", "set +o pipefail"]) {
      const body = ["#!/usr/bin/env bash", set, "git log | head -3"];
      expect(unguardedPipelines(dump({ land: shebang(body) }))).toHaveLength(1);
    }
  });

  test("`set +o pipefail` turns the guard back off", () => {
    const body = ["#!/usr/bin/env bash", "set -euo pipefail", "set +o pipefail", "git log | head -3"];
    expect(unguardedPipelines(dump({ land: shebang(body) }))).toHaveLength(1);
  });

  test("pipefail set after the pipeline does not guard it", () => {
    const body = ["#!/usr/bin/env bash", "git log | head -3", "set -euo pipefail"];
    expect(unguardedPipelines(dump({ land: shebang(body) }))).toHaveLength(1);
  });

  test("a non-shebang recipe cannot set pipefail, so the fix is a bash shebang", () => {
    const errors = unguardedPipelines(dump({ land: shebang(["git log | head -3"], false) }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#!/usr/bin/env bash");
  });

  // Ubuntu's `sh` is dash, which answers `set -o pipefail` with "Illegal option". Accepting it
  // here would bless the cheap fix over the one that works.
  test("`set -o pipefail` in a non-shebang recipe does not guard it", () => {
    const body = ["set -o pipefail", "git log | head -3"];
    const errors = unguardedPipelines(dump({ land: shebang(body, false) }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#!/usr/bin/env bash");
  });

  test("a justfile-wide pipefail shell does guard them, since that is the interpreter", () => {
    const shell = { command: "bash", arguments: ["-euo", "pipefail", "-c"] };
    const withShell = { ...dump({ land: shebang(["git log | head -3"], false) }), settings: { shell } };
    expect(unguardedPipelines(withShell)).toEqual([]);
  });

  // `just --dump` reports `shebang: true` for any shebang. `#!/bin/sh` is dash on Ubuntu, which
  // answers `set -o pipefail` with "Illegal option" — trusting the flag alone reopened the dash hole
  // one level up from where round 1 closed it.
  test("only an interpreter that has pipefail can enable it", () => {
    for (const line of ["#!/bin/sh", "#!/usr/bin/env sh", "#!/usr/bin/env python3"]) {
      const body = [line, "set -o pipefail", "git log | head -3"];
      const errors = unguardedPipelines(dump({ land: shebang(body) }));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("#!/usr/bin/env bash");
    }
    for (const line of ["#!/bin/bash", "#!/usr/bin/env bash", "#!/usr/bin/env zsh", "#!/usr/bin/env -S bash -e"]) {
      const body = [line, "set -o pipefail", "git log | head -3"];
      expect(unguardedPipelines(dump({ land: shebang(body) }))).toEqual([]);
    }
  });

  // Rounds 1-3 each closed one `set` spelling and left the next one silently guarded, because an
  // unparsed `set` counted as "says nothing". A `set` that mentions pipefail at all and does not
  // provably enable it now counts as off, so an unrecognised spelling fails closed by construction.
  test("a `set` that mentions pipefail without provably enabling it counts as off", () => {
    for (const off of ["set +o pipefail;", "set +o pipefail; git log | head -3"]) {
      const body = ["#!/usr/bin/env bash", "set -euo pipefail", off, "git log | head -3"];
      expect(unguardedPipelines(dump({ land: shebang(body) }))).toHaveLength(1);
    }
  });

  // Verified against bash: this really does enable pipefail, so flagging it is the cost of failing
  // closed on a spelling the scanner cannot prove. Writing `set -euo pipefail` is the fix.
  test("a quoted operand fails closed, which is a false positive and the intended direction", () => {
    const body = ["#!/usr/bin/env bash", "set -o 'pipefail'", "git log | head -3"];
    expect(unguardedPipelines(dump({ land: shebang(body) }))).toHaveLength(1);

    // The load-bearing half: an unprovable spelling must *revoke* a guard that was really on,
    // not be waved through as "says nothing".
    const revoked = ["#!/usr/bin/env bash", "set -euo pipefail", "set -o 'pipefail'", "git log | head -3"];
    expect(unguardedPipelines(dump({ land: shebang(revoked) }))).toHaveLength(1);
  });

  test("extra operands after the option do not stop it enabling", () => {
    const body = ["#!/usr/bin/env bash", "set -o pipefail extra-operand", "git log | head -3"];
    expect(unguardedPipelines(dump({ land: shebang(body) }))).toEqual([]);
  });

  test("a pipeline guarded earlier on its own line is still guarded", () => {
    const body = ["#!/usr/bin/env bash", "set -o pipefail; git log | head -3"];
    expect(unguardedPipelines(dump({ land: shebang(body) }))).toEqual([]);
  });

  // `$((1 | 2))` is bitwise OR, not a pipeline — the seam that treating every `$(` as command
  // substitution opened.
  test("arithmetic expansion is not a pipeline, but a substitution inside it still is", () => {
    for (const clean of ["x=$((1 | 2))", 'x="$((1 | 2))"', "x=$(( FLAGS | 4 ))"]) {
      expect(unguardedPipelines(dump({ land: shebang([clean], false) }))).toEqual([]);
    }
    expect(unguardedPipelines(dump({ land: shebang(["x=$(( $(a | b) ))"], false) }))).toHaveLength(1);
  });

  test("an env assignment before the interpreter does not hide it", () => {
    for (const line of ["#!/usr/bin/env FOO=bar bash", "#!/usr/bin/env -S FOO=bar bash"]) {
      const body = [line, "set -euo pipefail", "git log | head -3"];
      expect(unguardedPipelines(dump({ land: shebang(body) }))).toEqual([]);
    }
  });

  test("a later `set` that says nothing about pipefail leaves it on", () => {
    const body = ["#!/usr/bin/env bash", "set -euo pipefail", "set -x", "git log | head -3"];
    expect(unguardedPipelines(dump({ land: shebang(body) }))).toEqual([]);
  });

  test("`--` ends option parsing, so what follows it enables nothing", () => {
    const off = ["#!/usr/bin/env bash", "set -- -o pipefail", "git log | head -3"];
    expect(unguardedPipelines(dump({ land: shebang(off) }))).toHaveLength(1);
    const on = ["#!/usr/bin/env bash", "set -o pipefail --", "git log | head -3"];
    expect(unguardedPipelines(dump({ land: shebang(on) }))).toEqual([]);
  });

  test("a justfile-wide shell guards only when its argv really enables pipefail", () => {
    const body = { land: shebang(["git log | head -3"], false) };
    const withShell = (args: string[]) => ({ ...dump(body), settings: { shell: { command: "bash", arguments: args } } });
    expect(unguardedPipelines(withShell(["-o", "pipefail", "-c"]))).toEqual([]);
    expect(unguardedPipelines(withShell(["-euo", "pipefail", "-c"]))).toEqual([]);
    expect(unguardedPipelines(withShell(["+o", "pipefail", "-c"]))).toHaveLength(1);
    expect(unguardedPipelines(withShell(["-c", "pipefail"]))).toHaveLength(1);
  });

  // The status of `"$(a | b)"` is still the pipeline's, and reading the
  // whole double-quoted run as data missed every pipeline the justfile actually contains.
  test("a pipeline inside a quoted command substitution is shell, not data", () => {
    const piped = [
      'changed="$(git diff --name-only | sort -u)"',
      'changed="$( { git diff; git ls-files; } | sort -u )"',
      'changed="`git diff --name-only | sort -u`"',
    ];
    for (const line of piped) {
      expect(unguardedPipelines(dump({ land: shebang([line], false) }))).toHaveLength(1);
    }
  });

  test("a pipe that is merely inside double quotes is still data", () => {
    for (const line of ['echo "a | b"', 'grep -qE "a|b" file', 'echo "$(date) a | b"']) {
      expect(unguardedPipelines(dump({ land: shebang([line], false) }))).toEqual([]);
    }
  });

  test("`||` is not a pipeline", () => {
    expect(unguardedPipelines(dump({ land: shebang(["git log || exit 2"], false) }))).toEqual([]);
  });

  test("a pipe inside quotes is data, not a pipeline", () => {
    const body = ["grep -qE 'a|b' file", 'grep -qE "a|b" file'];
    expect(unguardedPipelines(dump({ land: shebang(body, false) }))).toEqual([]);
  });

  test("a pipe in a trailing comment is not a pipeline", () => {
    expect(unguardedPipelines(dump({ land: shebang(["git log # a | b"], false) }))).toEqual([]);
  });

  test("`>|` is a redirect, not a pipeline", () => {
    expect(unguardedPipelines(dump({ land: shebang(["git log >| out"], false) }))).toEqual([]);
  });

  // The dump carries a variable's *name*, never its value, so the scanner can never see whether
  // the substituted text pipes. It renders to a token boundary rather than to anything shell-like.
  test("an interpolated variable contributes no pipeline, whatever it is called", () => {
    for (const name of ["SLUG_PATTERN", "a|b"]) {
      const body = [['[[ "$1" =~ ', [["variable", name]], " ]]"]];
      expect(unguardedPipelines(dump({ land: { doc: "d", shebang: false, body } }))).toEqual([]);
    }
  });

  test("names one offending line per recipe, not one per pipe", () => {
    const body = ["a | b", "c | d"];
    expect(unguardedPipelines(dump({ land: shebang(body, false) }))).toHaveLength(1);
  });
});

// The gate's own subject matter: the extractor must find the real references and no English ones.
describe("the repository's own references", () => {
  test("CLAUDE.md spells its executable rituals as recipes, not as shell to copy", () => {
    const found = new Set(names("CLAUDE.md", readRepoFile("CLAUDE.md")));
    expect([...found].sort()).toEqual(["mutate", "worktree", "worktree-rm"]);
  });

  test("ci.yml calls verify-darwin-full rather than repeating its flags", () => {
    expect(names(YML, readRepoFile(YML))).toContain("verify-darwin-full");
  });
});

// #218: v1.4.4-cli release notes told users to `npm update -g`; install text says bun (#1278).
describe("npmGlobalCommands", () => {
  test.each([
    "npm install -g @drakulavich/kesha-voice-kit",
    "npm i -g @drakulavich/kesha-voice-kit@latest",
    "npm update -g @drakulavich/kesha-voice-kit",
    "npm remove -g @drakulavich/kesha-voice-kit",
    "npm uninstall --global @drakulavich/kesha-voice-kit",
    "npm install --global=true @drakulavich/kesha-voice-kit",
    "npm install --location=global @drakulavich/kesha-voice-kit",
    "npm -g install @drakulavich/kesha-voice-kit",
    "Upgrade with `npm up @drakulavich/kesha-voice-kit -g`.",
  ])("refuses %s", (line) => {
    const errors = npmGlobalCommands("README.md", `# Install\n\n${line}\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("README.md:3:");
    expect(errors[0]).toContain("bun add -g");
  });

  test("follows a shell line continuation, reporting the command's first line", () => {
    const errors = npmGlobalCommands("SKILL.md", "```bash\nnpm install \\\n  -g @drakulavich/kesha-voice-kit\n```\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("SKILL.md:2:");
  });

  test.each([
    "npm publish --provenance --access public",
    "npm install",
    "npm view @drakulavich/kesha-voice-kit@1.0.0 kesha.engine.version",
    "bun add -g @drakulavich/kesha-voice-kit",
    "bun remove -g @drakulavich/kesha-voice-kit",
    "npm install --save-dev typescript && bun add -g x",
    "pnpm install -g @scope/pkg",
    "npm install --global-style",
  ])("allows %s", (line) => {
    expect(npmGlobalCommands("README.md", line)).toEqual([]);
  });
});

describe("isNpmSwept", () => {
  test.each([
    "README.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "SKILL.md",
    "docs/distribution.md",
    ".claude/skills/release/SKILL.md",
    ".github/scripts/engine-release-notes.mjs",
    ".github/scripts/release-manifest.mjs",
  ])("sweeps %s", (path) => {
    expect(isNpmSwept(path)).toBe(true);
  });

  // raycast/ is an npm tree by design; workflows and smoke scripts are the maintainer publish path.
  test.each([
    "raycast/README.md",
    ".github/workflows/release.yml",
    ".github/scripts/release-install-smoke.sh",
    "docs/superpowers/specs/2026-05-30-lanes.md",
    "docs/assets/demo.webp",
  ])("leaves %s alone", (path) => {
    expect(isNpmSwept(path)).toBe(false);
  });

  test("the repository's own user-facing text carries no npm global install", () => {
    const files = npmSweptFiles(REPO_ROOT);
    expect(files).toContain("SKILL.md");
    expect(files).toContain(".github/scripts/engine-release-notes.mjs");
    expect(files.flatMap((path) => npmGlobalCommands(path, readRepoFile(path)))).toEqual([]);
  });
});

describe("sweepErrors", () => {
  function tree(files: Record<string, string>): string {
    const root = tempDir("recipes-sweep-");
    for (const dir of ["docs", ".claude/skills", ".github/workflows"]) mkdirSync(join(root, dir), { recursive: true });
    const defaults = { "README.md": "", "CONTRIBUTING.md": "", "CLAUDE.md": "" };
    for (const [path, content] of Object.entries({ ...defaults, ...files })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  test("reports an npm global install in SKILL.md alongside an unknown recipe", () => {
    const root = tree({
      "SKILL.md": "Upgrade:\n\n    npm update -g @drakulavich/kesha-voice-kit\n",
      "README.md": "Run `just nope`.\n",
    });
    const errors = sweepErrors(root, new Set(["test"]));
    expect(errors.some((error) => error.startsWith("SKILL.md:3:"))).toBe(true);
    expect(errors.some((error) => error.includes("`just nope`"))).toBe(true);
  });

  test("a checkout without .claude/skills/ still sweeps the rest", () => {
    const root = tree({ "SKILL.md": "npm i -g @drakulavich/kesha-voice-kit\n" });
    rmSync(join(root, ".claude/skills"), { recursive: true });
    expect(sweepErrors(root, new Set()).some((error) => error.startsWith("SKILL.md:1:"))).toBe(true);
  });

  test("a clean tree has nothing to report", () => {
    const root = tree({ "SKILL.md": "bun add -g @drakulavich/kesha-voice-kit\n", "README.md": "Run `just test`.\n" });
    expect(sweepErrors(root, new Set(["test"]))).toEqual([]);
  });
});
