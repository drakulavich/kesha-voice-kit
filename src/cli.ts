#!/usr/bin/env bun

import { transcribe } from "./lib";
import { downloadModel } from "./models";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    console.log(pkg.version);
    process.exit(0);
  }

  const positional = args.filter((a) => !a.startsWith("--"));

  if (positional[0] === "install") {
    const noCache = args.includes("--no-cache");
    try {
      await downloadModel(noCache);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  const file = positional[0];

  if (!file) {
    console.error("Usage: parakeet [--version] <audio_file>");
    console.error("       parakeet install [--no-cache]");
    process.exit(1);
  }

  try {
    const text = await transcribe(file);
    if (text) process.stdout.write(text + "\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}

main();
