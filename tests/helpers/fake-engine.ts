import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const ENGINE_ENV = ["KESHA_ENGINE_BIN", "KESHA_CACHE_DIR", "HOME", "KESHA_MODEL_MIRROR"] as const;

/** Snapshots the engine-related env so a test can point them at a temp dir and restore afterwards. */
export function saveEngineEnv(): () => void {
  const saved = ENGINE_ENV.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Writes an executable stub that answers `--capabilities-json` and exits 2 otherwise.
 * Pass `capabilities: null` for a binary that exists but cannot describe itself.
 */
export function writeFakeEngine(
  binDir: string,
  capabilities: Record<string, unknown> | null = {
    protocolVersion: 3,
    backend: "fake-coreml",
    features: ["tts"],
  },
): string {
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "kesha-engine");
  const body = capabilities
    ? `if [ "$1" = "--capabilities-json" ]; then\n  printf '%s\\n' '${JSON.stringify(capabilities)}'\n  exit 0\nfi\n`
    : "";
  writeFileSync(binPath, `#!/bin/sh\n${body}exit 2\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}
