import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
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
 * Redirects the whole engine cache into a throwaway dir for one test, and returns the undo.
 *
 * #796: pointing `KESHA_ENGINE_BIN` at a temp path is opt-in per test, so a test that reaches
 * `installEngine` before staging one falls back to `~/.cache/kesha` and overwrites the
 * developer's real engine. Overriding `KESHA_CACHE_DIR` makes that fallback harmless instead
 * of relying on every test to remember.
 */
export function isolateEngineCache(): () => void {
  const restore = saveEngineEnv();
  const dir = mkdtempSync(join(tmpdir(), "kesha-cache-isolated-"));
  process.env.KESHA_CACHE_DIR = dir;
  delete process.env.KESHA_ENGINE_BIN;
  return () => {
    restore();
    rmSync(dir, { recursive: true, force: true });
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

/**
 * Writes a stub in a fresh temp dir that answers `--capabilities-json` with `features`
 * and `transcribe` with `transcribeBody`, and returns its path.
 *
 * `transcribeBody` is shell, so a caller that needs to vary the reply by flag can branch.
 */
export function writeTranscribingEngine(
  prefix: string,
  features: string[],
  transcribeBody: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "kesha-engine");
  const capabilities = JSON.stringify({ protocolVersion: 2, backend: "fake", features });
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '${capabilities}'
  exit 0
fi
if [ "$1" = "transcribe" ]; then
${transcribeBody}
  exit 0
fi
exit 2
`,
  );
  chmodSync(path, 0o755);
  return path;
}
