import { access, constants, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const FALLBACK_CANDIDATES: ReadonlyArray<string> = [
  join(homedir(), ".bun", "bin", "kesha"),
  "/opt/homebrew/bin/kesha",
  "/usr/local/bin/kesha",
  join(homedir(), ".npm-global", "bin", "kesha"),
  join(homedir(), ".local", "bin", "kesha"),
];

const INTERPRETER_CANDIDATES: ReadonlyArray<string> = [
  join(homedir(), ".bun", "bin", "bun"),
  "/opt/homebrew/bin/bun",
  "/usr/local/bin/bun",
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/local/opt/node/bin/node",
];

export interface KeshaSpawn {
  command: string;
  prefixArgs: string[];
}

export interface KeshaBinDeps {
  candidates?: ReadonlyArray<string>;
  interpreterCandidates?: ReadonlyArray<string>;
  isExecutable?: (path: string) => Promise<boolean>;
  readShebang?: (path: string) => Promise<string | null>;
  realpath?: (path: string) => Promise<string>;
}

async function defaultIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function parseShebang(head: Buffer): string | null {
  if (head.length < 2 || head[0] !== 0x23 || head[1] !== 0x21) {
    return null;
  }
  const eol = head.indexOf(0x0a);
  const end = eol > 0 ? eol : head.length;
  return head.subarray(2, end).toString("utf8").trim();
}

async function defaultReadShebang(path: string): Promise<string | null> {
  try {
    const fd = await open(path, "r");
    try {
      const buf = Buffer.alloc(128);
      const { bytesRead } = await fd.read(buf, 0, 128, 0);
      return parseShebang(buf.subarray(0, bytesRead));
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

async function findInterpreter(
  name: string,
  deps: KeshaBinDeps,
): Promise<string | null> {
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  for (const path of deps.interpreterCandidates ?? INTERPRETER_CANDIDATES) {
    if (path.endsWith(`/${name}`) && (await isExecutable(path))) {
      return path;
    }
  }
  return null;
}

async function buildSpawn(
  path: string,
  deps: KeshaBinDeps,
): Promise<KeshaSpawn | null> {
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const readShebang = deps.readShebang ?? defaultReadShebang;
  const resolvePath = deps.realpath ?? realpath;
  if (!(await isExecutable(path))) {
    return null;
  }
  let resolved = path;
  try {
    resolved = await resolvePath(path);
  } catch {
    // Keep original path if the symlink target cannot be resolved.
  }
  const shebang = await readShebang(resolved);
  if (!shebang) {
    return { command: path, prefixArgs: [] };
  }
  const envMatch = shebang.match(/^\/usr\/bin\/env\s+([\w.-]+)/);
  if (envMatch) {
    const interp = await findInterpreter(envMatch[1], deps);
    if (interp) {
      return { command: interp, prefixArgs: [resolved] };
    }
  }
  return { command: path, prefixArgs: [] };
}

export async function resolveKeshaBin(
  preference: string | undefined,
  deps: KeshaBinDeps = {},
): Promise<KeshaSpawn | null> {
  const trimmed = preference?.trim();
  if (trimmed) {
    return buildSpawn(trimmed, deps);
  }
  for (const candidate of deps.candidates ?? FALLBACK_CANDIDATES) {
    const spawn = await buildSpawn(candidate, deps);
    if (spawn) {
      return spawn;
    }
  }
  return null;
}

export function notFoundMessage(): string {
  return [
    "kesha CLI not found. Set the `kesha` binary path preference to an absolute path,",
    "or install it with `bun add -g @drakulavich/kesha-voice-kit`.",
    `Probed: ${FALLBACK_CANDIDATES.join(", ")}`,
  ].join(" ");
}
