import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

const repoDir = resolve(import.meta.dir, "..", "..");

function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), "parakeet-coreml-install-"));
}

function getCoreMLBinPath(homeDir: string): string {
  return join(homeDir, ".cache", "parakeet", "coreml", "bin", "parakeet-coreml");
}

function writeExecutable(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createCurrentBinary(): string {
  return `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\n' '{"protocolVersion":1,"installState":"ready","supportedCommands":{"checkInstall":true,"downloadOnly":true}}'
  exit 0
fi
if [ "$1" = "--download-only" ]; then
  echo "unexpected download" >&2
  exit 9
fi
echo "unexpected args: $*" >&2
exit 10
`;
}

function createStaleBinary(): string {
  return `#!/bin/sh
echo "legacy binary: $1" >&2
exit 1
`;
}

function createDownloadedBinary(): string {
  return `#!/bin/sh
MARKER_DIR="$(dirname "$0")/.."
MARKER_PATH="$MARKER_DIR/models-installed"
if [ "$1" = "--capabilities-json" ]; then
  if [ -f "$MARKER_PATH" ]; then
    STATE=ready
  else
    STATE=models-missing
  fi
  printf '{"protocolVersion":1,"installState":"%s","supportedCommands":{"checkInstall":true,"downloadOnly":true}}\\n' "$STATE"
  exit 0
fi
if [ "$1" = "--download-only" ]; then
  mkdir -p "$MARKER_DIR"
  touch "$MARKER_PATH"
  echo "downloaded"
  exit 0
fi
echo "unexpected args: $*" >&2
exit 11
`;
}

async function runDownloadCoreML(args: {
  homeDir: string;
  fetchScriptBody: string;
  noNetwork?: boolean;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const runnerPath = join(args.homeDir, "run-download-coreml.ts");
  await Bun.write(
    runnerPath,
    `
      import { downloadCoreML } from "./src/coreml-install.ts";
    `.replace(`"./src/coreml-install.ts"`, JSON.stringify(join(repoDir, "src", "coreml-install.ts"))) + `

      const fetchBody = process.env.TEST_FETCH_SCRIPT;
      if (process.env.TEST_DISABLE_FETCH === "1") {
        globalThis.fetch = async () => {
          throw new Error("fetch should not be called");
        };
      } else {
        globalThis.fetch = async () => new Response(fetchBody);
      }

      const binPath = await downloadCoreML(false);
      console.log("BIN_PATH=" + binPath);
    `,
  );

  const proc = Bun.spawn(["bun", runnerPath], {
    cwd: repoDir,
    env: {
      ...process.env,
      HOME: args.homeDir,
      TEST_FETCH_SCRIPT: args.fetchScriptBody,
      TEST_DISABLE_FETCH: args.noNetwork ? "1" : "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe("e2e-coreml-install", () => {
  test("reuses a current cached CoreML binary without downloading", async () => {
    const homeDir = createTempHome();
    const binPath = getCoreMLBinPath(homeDir);

    try {
      writeExecutable(binPath, createCurrentBinary());

      const result = await runDownloadCoreML({
        homeDir,
        fetchScriptBody: createDownloadedBinary(),
        noNetwork: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CoreML backend already installed.");
      expect(result.stdout).toContain(`BIN_PATH=${binPath}`);
      expect(readFileSync(binPath, "utf8")).toContain('"installState":"ready"');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("refreshes a stale cached CoreML binary before installing models", async () => {
    const homeDir = createTempHome();
    const binPath = getCoreMLBinPath(homeDir);

    try {
      writeExecutable(binPath, createStaleBinary());

      const result = await runDownloadCoreML({
        homeDir,
        fetchScriptBody: createDownloadedBinary(),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Downloading parakeet-coreml binary...");
      expect(result.stdout).toContain("downloaded");
      expect(result.stdout).toContain("CoreML backend installed successfully.");

      const probe = Bun.spawnSync([binPath, "--capabilities-json"], {
        env: {
          ...process.env,
          HOME: homeDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(probe.exitCode).toBe(0);
      expect(probe.stdout.toString()).toContain('"installState":"ready"');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);
});
