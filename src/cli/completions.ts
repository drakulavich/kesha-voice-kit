import { defineCommand } from "citty";
import { log } from "../log";
import { renderInvalidArg } from "./options";
// Inlined because import.meta.url escapes the embedded filesystem in the compiled .deb/.rpm binary (#914).
import bashCompletions from "../../completions/kesha.bash" with { type: "text" };
import zshCompletions from "../../completions/kesha.zsh" with { type: "text" };
import fishCompletions from "../../completions/kesha.fish" with { type: "text" };

const SHELL_SCRIPTS = {
  bash: bashCompletions,
  zsh: zshCompletions,
  fish: fishCompletions,
} as const;

type Shell = keyof typeof SHELL_SCRIPTS;

interface CompletionsCommandArgs {
  shell?: string;
}

function isShell(value: string): value is Shell {
  return value === "bash" || value === "zsh" || value === "fish";
}

export const completionsCommand = defineCommand({
  meta: {
    name: "completions",
    description: "Print shell completion script for bash, zsh, or fish",
  },
  args: {
    shell: {
      type: "positional",
      required: false,
      description: "Shell: bash | zsh | fish",
    },
  },
  async run({ args }: { args: CompletionsCommandArgs }) {
    const shell = args.shell;
    if (!shell || !isShell(shell)) {
      log.error(renderInvalidArg(shell ? `unknown shell '${shell}' (bash, zsh or fish)` : "missing shell (bash, zsh or fish)"));
      process.stderr.write("usage: kesha completions <bash|zsh|fish>\n");
      process.exit(2);
    }
    process.stdout.write(SHELL_SCRIPTS[shell]);
  },
});
