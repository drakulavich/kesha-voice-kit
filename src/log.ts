import pc from "picocolors";

/**
 * Colorizer indirection (#531). `picocolors` decides color support once at
 * import time (honoring `NO_COLOR`, TTY, `FORCE_COLOR`). To support a runtime
 * `--no-color` flag we keep a swappable reference: `setColorEnabled(false)`
 * replaces it with a no-op colorizer. Methods below read `colors.*`, never the
 * frozen default binding, so the toggle takes effect immediately.
 */
// Narrower type than the default export (which also carries `createColors`),
// so the no-op colorizer from `createColors(false)` is assignable back.
let colors: ReturnType<typeof pc.createColors> = pc;

/** Force colors on/off at runtime (used by `--no-color`). */
export function setColorEnabled(enabled: boolean): void {
  colors = enabled ? pc : pc.createColors(false);
}

/**
 * Debug mode (#148): when `KESHA_DEBUG` is truthy OR the caller has flipped
 * `log.debugEnabled = true` (via `--debug`), `log.debug()` writes structured
 * trace lines to stderr. Otherwise it's a no-op. Stdout is never touched.
 *
 * Grammar (#275 D9): values that turn debug OFF — empty, `"0"`, `"false"`,
 * `"no"`, `"off"`, all matched **case-insensitively** after trimming. Any
 * other non-empty value turns debug ON. The Rust engine mirrors this list
 * verbatim in `rust/src/debug.rs` so `KESHA_DEBUG=False` flips both sides
 * the same direction.
 */
const KESHA_DEBUG_OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

function envDebug(): boolean {
  const v = process.env.KESHA_DEBUG;
  if (v === undefined) return false;
  return !KESHA_DEBUG_OFF_VALUES.has(v.trim().toLowerCase());
}

/**
 * Module-load timestamp for relative-since-start prefixes on debug lines.
 * The CLI runs nothing of substance before this file is imported, so this
 * is effectively process-start. Recorded once.
 */
const PROCESS_T0_MS = performance.now();

export const log = {
  info: (msg: string) => console.log(msg),
  success: (msg: string) => console.log(colors.green(msg)),
  // `--quiet` (#526) silences status/progress chatter; warnings and errors
  // always print, and results are written straight to stdout (not via log.*).
  progress: (msg: string) => {
    if (log.quietEnabled) return;
    console.log(colors.cyan(msg));
  },
  // stderr via process.stderr.write (not console.error): Bun auto-colors
  // console.error red in a TTY, and that decision is frozen at startup — it
  // would survive `--no-color`. Writing the stream directly leaves picocolors
  // (which `setColorEnabled` controls) as the only colorizer, so `--no-color`
  // and `CI=true` produce genuinely plain output. (#531)
  warn: (msg: string) => void process.stderr.write(colors.yellow(msg) + "\n"),
  error: (msg: string) => void process.stderr.write(colors.red(msg) + "\n"),

  quietEnabled: false,
  debugEnabled: false,
  isDebugEnabled(): boolean {
    return this.debugEnabled || envDebug();
  },
  debug(msg: string): void {
    if (this.isDebugEnabled()) {
      // `[debug +Nms]` prefix sits on the CLI process's own timeline so
      // the reader can see when each line fired. The Rust engine emits
      // the same `+Nms` shape from `rust/src/debug.rs::trace_fmt`, but
      // anchored to its own process start — the two axes are
      // independent. For "duration between two events on the same
      // process", read the prefix difference; for cross-process spans,
      // the spawn→exit `dt=Nms` inside the message remains authoritative.
      const t = Math.round(performance.now() - PROCESS_T0_MS);
      process.stderr.write(colors.dim(`[debug +${t}ms] ${msg}`) + "\n");
    }
  },
};
