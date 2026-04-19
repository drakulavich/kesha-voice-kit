import pc from "picocolors";

/**
 * Debug mode (#148): when `KESHA_DEBUG` is truthy OR the caller has flipped
 * `log.debugEnabled = true` (via `--debug`), `log.debug()` writes structured
 * trace lines to stderr. Otherwise it's a no-op. Stdout is never touched.
 */
function envDebug(): boolean {
  const v = process.env.KESHA_DEBUG;
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

export const log = {
  info: (msg: string) => console.log(msg),
  success: (msg: string) => console.log(pc.green(msg)),
  progress: (msg: string) => console.log(pc.cyan(msg)),
  warn: (msg: string) => console.error(pc.yellow(msg)),
  error: (msg: string) => console.error(pc.red(msg)),

  debugEnabled: false,
  debug(msg: string): void {
    if (this.debugEnabled || envDebug()) {
      console.error(pc.dim(`[debug] ${msg}`));
    }
  },
};
