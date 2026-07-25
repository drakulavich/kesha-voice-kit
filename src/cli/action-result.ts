import { log } from "../log";

export type ActionMessage = { level: "success" | "info" | "warn"; text: string };

export type ActionResult =
  | { ok: true; messages: ActionMessage[]; stdout?: string }
  | { ok: false; error: string; hint?: string };

/** Renders an action's messages, writing `stdout` verbatim; a rejected action exits 2. */
export function emitActionResult(result: ActionResult): void {
  if (!result.ok) {
    log.error(result.error);
    if (result.hint) log.warn(result.hint);
    process.exit(2);
  }
  for (const message of result.messages) log[message.level](message.text);
  if (result.stdout !== undefined) process.stdout.write(result.stdout);
}
