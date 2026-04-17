import { readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { isEngineInstalled, getEngineBinPath, getEngineCapabilities } from "./engine";
import { log } from "./log";
import pc from "picocolors";

export function formatStatusLine(
  label: string,
  path: string | null,
  installed: boolean,
  missingLabel = "not installed",
): string {
  const status = installed ? pc.green("✓") : pc.red(`✗ ${missingLabel}`);
  const pathStr = path ?? "";
  const padding = " ".repeat(Math.max(1, 50 - label.length - pathStr.length));
  return `  ${label}:${pathStr ? `   ${pathStr}` : ""}${padding}${status}`;
}

export async function showStatus(): Promise<void> {
  const binPath = getEngineBinPath();
  const installed = isEngineInstalled();

  log.info("Engine:");
  log.info(formatStatusLine("Binary", installed ? binPath : null, installed));

  if (installed) {
    const caps = await getEngineCapabilities();
    if (caps) {
      log.info(formatStatusLine("Backend", caps.backend, true));
      log.info(formatStatusLine("Protocol", `v${caps.protocolVersion}`, true));
      log.info(formatStatusLine("Features", caps.features.join(", "), true));
    } else {
      log.info(formatStatusLine("Capabilities", null, false, "probe failed"));
    }
  }
  log.info("");

  log.info(formatStatusLine("Runtime", `Bun ${Bun.version}`, true));
  log.info(formatStatusLine("Platform", `${process.platform} ${process.arch}`, true));
  log.info("");

  if (installed) {
    const voices = listInstalledVoices();
    if (voices.length > 0) {
      log.info("TTS voices:");
      for (const v of voices) {
        log.info(`  ${v}`);
      }
      log.info("");
    }
  }

  if (!installed) {
    log.warn('Run "kesha install" to download the engine and models.');
  }
}

function kesheCacheDir(): string {
  return process.env.KESHA_CACHE_DIR ?? join(homedir(), ".cache", "kesha");
}

function listInstalledVoices(): string[] {
  const voicesDir = join(kesheCacheDir(), "models", "kokoro-82m", "voices");
  try {
    return readdirSync(voicesDir)
      .filter((f) => f.endsWith(".bin"))
      .map((f) => `en-${f.replace(/\.bin$/, "")}`);
  } catch {
    return [];
  }
}
