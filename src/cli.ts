#!/usr/bin/env bun

import { existsSync } from "fs";
import { transcribe } from "./transcribe";

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

  if (!existsSync(file)) {
    console.error(`Error: file not found: ${file}`);
    process.exit(1);
  }

  try {
    const text = await transcribe(file, { noCache });
    if (text) process.stdout.write(text + "\n");
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
