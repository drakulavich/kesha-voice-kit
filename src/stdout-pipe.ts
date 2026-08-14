import { errorMessage } from "./error-utils";
import { log } from "./log";

let guarded = false;

/**
 * Keeps a reader that stops reading — `kesha say | ffplay -` then quit, `| head -c 1000` for
 * a preview — from reading as a crash. Bun delivers a stdout EPIPE asynchronously, past any
 * try/catch around the write, so it escaped as an uncaught stack trace and turned a
 * successful synthesis into exit 1 (#1001). EPIPE alone means the reader left; every other
 * write failure still reports and exits non-zero.
 */
export function guardStdoutWrites(): void {
  if (guarded) return;
  guarded = true;
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE") {
      log.debug("stdout closed by the reader; nothing left to write");
      return;
    }
    log.error(
      `failed writing to stdout: ${errorMessage(err)}. Check that the destination is writable and has free space.`,
    );
    process.exitCode = 1;
  });
}
