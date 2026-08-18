import { describe, expect, test } from "bun:test";
import {
  commandLines,
  interpolatedParameters,
  isSwept,
  type JustDump,
  knownRecipeNames,
  referencedRecipes,
  sweptFiles,
  undocumentedRecipes,
  unguardedPipelines,
  unknownReferences,
} from "../../.github/scripts/check-recipes";
import { readRepoFile, REPO_ROOT } from "../helpers/repo";

const MD = "CLAUDE.md";
const YML = ".github/workflows/rust-test.yml";

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
    expect(names(MD, "`just FILE=src/errors.rs FEATURES=tts mutants-rust`")).toEqual(["mutants-rust"]);
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
    ".claude/commands/preflight.md",
    ".claude/skills/release-mechanics/SKILL.md",
    ".github/workflows/rust-test.yml",
  ])("sweeps %s", (path) => {
    expect(isSwept(path)).toBe(true);
  });

  // Historical records: they describe what was true when written, not what is true now.
  test.each(["docs/superpowers/specs/2026-05-30-lanes.md", "docs/plans/completed/2026-05-11-nix.md"])(
    "excludes %s",
    (path) => {
      expect(isSwept(path)).toBe(false);
    },
  );

  test.each(["src/engine.ts", "justfile", ".claude/settings.json", "docs/assets/demo.gif"])(
    "ignores %s",
    (path) => {
      expect(isSwept(path)).toBe(false);
    },
  );
});

describe("sweptFiles", () => {
  const files = sweptFiles(REPO_ROOT);

  test("finds the files #797 names", () => {
    for (const path of ["CLAUDE.md", "docs/architecture.md", ".claude/commands/preflight.md"]) {
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
    expect([...found].sort()).toEqual([
      "dev-setup",
      "gate",
      "mutate",
      "preflight",
      "release",
      "release-tag",
      "review",
      "rust-test",
      "smoke-test",
      "test",
      "verify-darwin-full",
      "worktree",
      "worktree-rm",
    ]);
  });

  test("rust-test.yml calls verify-darwin-full rather than repeating its flags", () => {
    expect(names(YML, readRepoFile(YML))).toContain("verify-darwin-full");
  });
});
