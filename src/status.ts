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

  if (!installed) {
    log.warn('Run "parakeet install" to download the engine and models.');
  }
}
