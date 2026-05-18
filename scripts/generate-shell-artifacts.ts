#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { generateShellArtifacts } from "../src/shell-artifacts";

for (const artifact of await generateShellArtifacts()) {
  const path = join(process.cwd(), artifact.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, artifact.content);
  console.log(`wrote ${artifact.path}`);
}
