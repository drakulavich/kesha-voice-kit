#!/usr/bin/env bun

import { transcribe } from "./lib";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    console.log(pkg.version);
    process.exit(0);
  }

  const noCache = args.includes("--no-cache");
  const file = args.filter((a) => !a.startsWith("--"))[0];

  if (!file) {
    console.error("Usage: parakeet [--no-cache] <audio_file>");
    process.exit(1);
  }

  try {
    const text = await transcribe(file, { noCache });
    if (text) process.stdout.write(text + "\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
