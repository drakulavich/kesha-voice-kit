import { dirname } from "path";
import { existsSync, mkdirSync, chmodSync } from "fs";
import { getEngineBinPath } from "./engine";
import { log } from "./log";
import { streamResponseToFile } from "./progress";

const GITHUB_REPO = "drakulavich/kesha-voice-kit";

function getEngineBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return "kesha-engine-darwin-arm64";
  if (platform === "linux" && arch === "x64") return "kesha-engine-linux-x64";
  if (platform === "win32" && arch === "x64") return "kesha-engine-windows-x64.exe";

  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

export async function downloadEngine(noCache = false): Promise<string> {
  const binPath = getEngineBinPath();

  if (!noCache && existsSync(binPath)) {
    log.success("Engine binary already installed.");
  } else {
    const binaryName = getEngineBinaryName();
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const version = typeof pkg.version === "string" ? pkg.version : "unknown";
    const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryName}`;

    mkdirSync(dirname(binPath), { recursive: true });

    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow" });
    } catch (e) {
      throw new Error(
        `Failed to fetch engine binary: ${e instanceof Error ? e.message : e}\n  Fix: Check your network connection and try again`,
      );
    }

    if (!res.ok) {
      throw new Error(
        `Failed to download engine binary (HTTP ${res.status})\n  Fix: Check https://github.com/${GITHUB_REPO}/releases for available versions`,
      );
    }

    await streamResponseToFile(res, binPath, "kesha-engine binary");
    chmodSync(binPath, 0o755);
    log.success("Engine binary downloaded.");
  }

  log.progress("Installing models...");
  const proc = Bun.spawnSync([binPath, "install", ...(noCache ? ["--no-cache"] : [])], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.stderr.toString()) {
    process.stderr.write(proc.stderr.toString());
  }

  if (proc.exitCode !== 0) {
    const detail = proc.stderr.toString().trim();
    throw new Error(detail ? `Failed to install models: ${detail}` : "Failed to install models");
  }

  log.success("Backend installed successfully.");
  return binPath;
}
