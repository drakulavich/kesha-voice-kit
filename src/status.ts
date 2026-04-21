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
  const mirror = activeModelMirror();
  if (mirror) {
    log.info(formatStatusLine("Mirror", mirror, true));
  }
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

/**
 * Read the effective `KESHA_MODEL_MIRROR` base URL (#121). Returns null when
 * unset, empty, or whitespace. Matches the Rust side's `model_mirror()` in
 * `rust/src/models.rs` — keeping them in lockstep lets `kesha status`
 * surface the exact URL the engine will hit on the next `kesha install`.
 */
export function activeModelMirror(): string | null {
  const raw = process.env.KESHA_MODEL_MIRROR ?? "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

function listInstalledVoices(): string[] {
  const cache = kesheCacheDir();
  const voices: string[] = [];
  try {
    const kokoro = readdirSync(join(cache, "models", "kokoro-82m", "voices"));
    for (const f of kokoro) {
      if (f.endsWith(".bin")) voices.push(`en-${f.replace(/\.bin$/, "")}`);
    }
  } catch {
    /* Kokoro not installed */
  }
  try {
    // Piper RU files follow `ru_RU-<name>-<quality>.onnx` — report just `<name>`.
    const piper = readdirSync(join(cache, "models", "piper-ru"));
    for (const f of piper) {
      if (!f.endsWith(".onnx")) continue;
      const stem = f.replace(/\.onnx$/, "");
      const name = stem.replace(/^ru_RU-/, "").split("-")[0];
      if (name) voices.push(`ru-${name}`);
    }
  } catch {
    /* Piper not installed */
  }
  return voices.sort();
}
