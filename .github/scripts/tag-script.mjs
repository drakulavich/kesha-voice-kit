/**
 * The entry-point half of a workflow script that turns a tag into `$GITHUB_OUTPUT` lines.
 *
 * Only the grammar lives in release-tags.mjs; this is the argv/usage/exit-code contract the
 * workflows depend on, shared so two scripts cannot drift on it.
 */
import { pathToFileURL } from "node:url";

export function runTagScript(moduleUrl, { usage, run }) {
  if (moduleUrl !== pathToFileURL(process.argv[1] ?? "").href) return;

  const tag = process.argv[2];
  if (!tag) {
    console.error(usage);
    process.exit(2);
  }

  const outputs = run(tag);
  process.stdout.write(
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
