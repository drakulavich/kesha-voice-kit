import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { vi } from "vitest";

type FakeStdin = { destroyed: boolean; end: ReturnType<typeof vi.fn> };

function makeStdin(): FakeStdin {
  const stdin: FakeStdin = {
    destroyed: false,
    end: vi.fn(() => {
      stdin.destroyed = true;
    }),
  };
  return stdin;
}

// Node gives a stream only for a piped fd, so "ignore" must be absent here too —
// otherwise a spawn that never asked for stdin still looks stoppable.
function piped(options: SpawnOptions | undefined, fd: number): boolean {
  const stdio = options?.stdio;
  return !Array.isArray(stdio) || stdio[fd] !== "ignore";
}

export class FakeProcess extends EventEmitter {
  pid = 1234;
  exitCode: number | null = null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  stdin: FakeStdin | null;
  kill = vi.fn();

  constructor(options?: SpawnOptions) {
    super();
    this.stdin = piped(options, 0) ? makeStdin() : null;
    this.stdout = piped(options, 1) ? new EventEmitter() : null;
    this.stderr = piped(options, 2) ? new EventEmitter() : null;
  }

  emitStdout(value: string) {
    this.stdout?.emit("data", Buffer.from(value));
  }

  emitStderr(value: string) {
    this.stderr?.emit("data", Buffer.from(value));
  }

  endStdout() {
    this.stdout?.emit("end");
  }

  exit(code: number | null) {
    this.exitCode = code;
    this.emit("exit", code);
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

export function createSpawnRecorder() {
  const calls: Array<{
    command: string;
    args: string[];
    options: SpawnOptions;
  }> = [];
  const processes: FakeProcess[] = [];
  const spawn = vi.fn(
    (command: string, args: string[], options: SpawnOptions) => {
      calls.push({ command, args, options });
      const proc = new FakeProcess(options);
      processes.push(proc);
      return proc.asChild();
    },
  );
  return { spawn, calls, processes };
}
