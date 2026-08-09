import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const REPO_ROOT = join(import.meta.dir, "..", "..");

export function repoPath(path: string): string {
  return join(REPO_ROOT, path);
}

/** Normalised, not inherited: a Windows checkout carries CRLF, which no assertion here is about. */
export function readRepoFile(path: string): string {
  return readFileSync(repoPath(path), "utf8").replace(/\r\n/g, "\n");
}

export function parseRepoYaml(path: string): any {
  return parse(readRepoFile(path));
}
