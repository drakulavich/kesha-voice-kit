// Pick the right setup-command hint for error/warning messages. Humans on an
// interactive TTY get `kesha init` (guided + idempotent), agents and scripts
// piping stderr get `kesha install [...flags]` (deterministic + scriptable).
//
// Flags forward to BOTH paths. `kesha init` accepts the same module-selection
// flags as `kesha install` (`--tts`, `--vad`, `--diarize`, `--coreml`, `--onnx`,
// `--no-cache`) — they preselect modules in the interactive wizard rather than
// being install-only flags. Source of truth: `src/cli/init.ts::initCommand.args`.
export function installHint(...flags: string[]): string {
  // `kesha init` refuses unless stdin and stdout are terminals (#1373), so a piped run gets `install` (#1380).
  const interactive = process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY;
  const verb = interactive ? "kesha init" : "kesha install";
  return [verb, ...flags].join(" ");
}
