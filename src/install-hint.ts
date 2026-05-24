// Pick the right setup-command hint for error/warning messages. Humans on an
// interactive TTY get `kesha init` (guided + idempotent), agents and scripts
// piping stderr get `kesha install [...flags]` (deterministic + scriptable).
export function installHint(...flags: string[]): string {
  const verb = process.stderr.isTTY ? "kesha init" : "kesha install";
  return [verb, ...flags].join(" ");
}
