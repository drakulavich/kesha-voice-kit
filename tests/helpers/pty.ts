import { REPO_ROOT } from "./repo";

export interface PtyRun {
  /** Everything the terminal has shown so far, ANSI sequences included. */
  output(): string;
  /** Resolves once the screen shows `text`; rejects with the screen so far after `timeoutMs`. */
  waitFor(text: string, timeoutMs?: number): Promise<void>;
  write(keys: string): void;
  /** Resolves with the exit code; kills the process and rejects after `timeoutMs`. */
  exited(timeoutMs?: number): Promise<number>;
}

/** Runs `argv` with stdin, stdout and stderr on one pseudo-terminal (#1414). POSIX only: Bun has no PTY on Windows. */
export function runInPty(argv: string[], env: Record<string, string | undefined>): PtyRun {
  let screen = "";
  const waiters = new Set<() => void>();
  const decoder = new TextDecoder();
  const proc = Bun.spawn(argv, {
    cwd: REPO_ROOT,
    env,
    terminal: {
      cols: 120,
      rows: 40,
      data(_terminal, chunk) {
        screen += decoder.decode(chunk, { stream: true });
        for (const check of waiters) check();
      },
    },
  });

  return {
    output: () => screen,
    waitFor(text, timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!screen.includes(text)) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`the terminal never showed ${JSON.stringify(text)}; it showed:\n${screen}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    write: (keys) => proc.terminal?.write(keys),
    async exited(timeoutMs = 20_000) {
      const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
      const code = await proc.exited;
      clearTimeout(timer);
      if (proc.signalCode === "SIGKILL") throw new Error(`still running after ${timeoutMs} ms; the terminal showed:\n${screen}`);
      return code;
    },
  };
}
