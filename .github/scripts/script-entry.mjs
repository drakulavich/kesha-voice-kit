/**
 * The entry-point half of a workflow script: one argument, one usage line, exit 2.
 *
 * The scripts themselves stay importable — a test calls the exported function directly. This
 * is only the argv/usage/exit-code contract the workflows depend on, shared so five of them
 * cannot drift on it.
 */
import { pathToFileURL } from "node:url";

/** `process.argv[2]` when this module is what node was pointed at, else undefined. */
export function entryArg(moduleUrl, usage) {
  if (moduleUrl !== pathToFileURL(process.argv[1] ?? "").href) return undefined;

  const arg = process.argv[2];
  if (!arg) {
    console.error(usage);
    process.exit(2);
  }
  return arg;
}

export function runTagScript(moduleUrl, { usage, run }) {
  const tag = entryArg(moduleUrl, usage);
  if (!tag) return;

  process.stdout.write(
    Object.entries(run(tag))
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
