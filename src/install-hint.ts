// Pick the right setup-command hint for error/warning messages. Humans on an
// interactive TTY get `kesha init` (guided + idempotent), agents and scripts
// piping stderr get `kesha install [...flags]` (deterministic + scriptable).
//
// Flags forward to BOTH paths. `kesha init` accepts the same module-selection
// flags as `kesha install` (`--tts`, `--vad`, `--diarize`, `--coreml`, `--onnx`,
// `--no-cache`) — they preselect modules in the interactive wizard rather than
// being install-only flags. Source of truth: `src/cli/init.ts::initCommand.args`.
export function installHint(...flags: string[]): string {
  const verb = process.stderr.isTTY ? "kesha init" : "kesha install";
  return [verb, ...flags].join(" ");
}
