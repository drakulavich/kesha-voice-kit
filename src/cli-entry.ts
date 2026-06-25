#!/usr/bin/env bun

// Runtime entry kept off the ./cli barrel, whose re-exports would eagerly load every command (#568).
import { runCli } from "./cli/dispatch";

if (import.meta.main) {
  await runCli();
}
