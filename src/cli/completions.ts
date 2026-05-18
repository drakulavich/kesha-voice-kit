import { defineCommand } from "citty";
import { log } from "../log";

const SHELL_FILES = {
  bash: "kesha.bash",
  zsh: "kesha.zsh",
  fish: "kesha.fish",
} as const;

type Shell = keyof typeof SHELL_FILES;

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
      required: true,
      description: "Shell: bash | zsh | fish",
    },
  },
  async run({ args }: { args: CompletionsCommandArgs }) {
    const shell = args.shell;
    if (!shell || !isShell(shell)) {
      log.error("usage: kesha completions <bash|zsh|fish>");
      process.exit(2);
    }
    const file = new URL(`../../completions/${SHELL_FILES[shell]}`, import.meta.url);
    process.stdout.write(await Bun.file(file).text());
  },
});
