import { dirname, join } from "path";
import { errorMessage } from "./error-utils";
import { tmpdir } from "os";
import { existsSync, mkdirSync, chmodSync, accessSync, constants, rmSync } from "fs";
import {
  getEngineBinPath,
  getEngineCapabilities,
  TRANSCRIBE_DIARIZE_FEATURE,
  type EngineCapabilities,
} from "./engine";
import { probeExecutable } from "./engine-health";
import { engineTarget } from "./engine-targets";
import { isDarwinArm64 } from "./fluid-kokoro-cache";
import { log } from "./log";
import { engineVersion } from "./package-info";
import { streamResponseToFile } from "./progress";
import {
  readInstalledEngineVersion,
  writeInstalledEngineVersion,
} from "./engine-version-marker";

export {
  getVersionMarkerPath,
  readInstalledEngineVersion,
  writeInstalledEngineVersion,
} from "./engine-version-marker";

const GITHUB_REPO = "drakulavich/kesha-voice-kit";

export function getEngineBinaryName(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const target = engineTarget(platform, arch);
  if (!target) throw new Error(`Unsupported platform: ${platform} ${arch}`);
  return target.assetName;
}

/** Sidecar spec — centralises AVSpeech (#141) and future sidecars so each is one entry. */
interface SidecarSpec {
  /** Written next to the engine binary; Rust probes this exact name. */
  fileBasename: string;
  /** Release asset name — may differ from fileBasename (e.g. `say-avspeech-darwin-arm64` vs `say-avspeech`). */
  assetName: string;
  displayName: string;
  availableHint: string;
  unavailableHint: string;
}

export const SIDECARS: SidecarSpec[] = [
  {
    fileBasename: "say-avspeech",
    assetName: "say-avspeech-darwin-arm64",
    displayName: "AVSpeech sidecar",
    availableHint: "macOS voices available",
    unavailableHint: "macos-* voices unavailable",
  },
  // Kokoro TTS (#207) and speaker diarization (#199) no longer ship as Swift
  // sidecars — both run in-engine via the native `fluidaudio-rs` binding. Only
  // the AVSpeech and text-lang sidecars remain.
  {
    // Runtime resolver looks for plain `kesha-textlang` next to the engine
    // (see `rust/src/text_lang.rs::helper_path`), not the platform-suffixed
    // release-asset name. Mismatch is intentional: the asset name needs the
    // suffix for GitHub-release uniqueness; the sidecar lookup wants the
    // unsuffixed binary so the same Rust code path works on the build-time
    // OUT_DIR baked fallback.
    fileBasename: "kesha-textlang",
    assetName: "kesha-textlang-darwin-arm64",
    displayName: "Text-lang sidecar",
    availableHint: "detect-text-lang fast path",
    unavailableHint:
      "detect-text-lang will fail until next `kesha install` (no swift -e fallback)",
  },
];

const RETIRED_SIDECAR_FILENAMES = [
  // Historical installed filenames.
  "kesha-kokoro",
  "kesha-diarize",
  // Historical release-asset filenames. Keep these explicit: AVSpeech and
  // text-lang helpers are still active and must not be swept up by a glob.
  "kesha-kokoro-darwin-arm64",
  "kesha-diarize-darwin-arm64",
];

export function cleanupRetiredSidecars(engineDir: string): string[] {
  const removed: string[] = [];

  for (const filename of RETIRED_SIDECAR_FILENAMES) {
    const path = join(engineDir, filename);
    if (!existsSync(path)) continue;

    try {
      rmSync(path);
      removed.push(filename);
    } catch (e) {
      log.warn(
        `Could not remove retired sidecar ${filename} (${errorMessage(e)}); continuing.`,
      );
    }
  }

  if (removed.length > 0) {
    log.success(`Removed retired sidecars: ${removed.join(", ")}.`);
  }

  return removed;
}

/**
 * Make a freshly-downloaded Mach-O runnable on macOS 15+ Sequoia.
 *
 * The release binaries ship `Signature=adhoc` (built via `cargo build`,
 * no Apple Developer ID). When fetched via HTTPS into `~/.cache/...`,
 * macOS attaches a `com.apple.provenance` xattr identifying the download
 * source. Combined with stricter Gatekeeper policy on macOS 15+ Sequoia,
 * the resulting "untrusted downloaded ad-hoc binary" is killed with
 * SIGKILL on first invocation (exit 137), with no log line — Gatekeeper
 * denies before Rust's main runs.
 *
 * Two independent fixes run in sequence; both are best-effort:
 *
 * 1. `codesign --force --sign - <path>` — re-applies the ad-hoc
 *    signature with the user's own host identity, defeating the trust
 *    mismatch.
 * 2. `xattr -d com.apple.provenance <path>` — strips the provenance
 *    marker entirely. Cheaper than codesign and works even when
 *    `codesign` is absent from PATH (corporate-locked machine, minimal
 *    CI image).
 *
 * Either step alone has unblocked the SIGKILL in field reports, so we
 * run both. If both fail, surface the manual recovery commands in
 * stderr. Linux/Windows paths never reach this function.
 */
function darwinTrustBinary(path: string, displayName: string): void {
  if (process.platform !== "darwin") return;
  let codesignOk = false;
  let xattrOk = false;
  try {
    const proc = Bun.spawnSync(["codesign", "--force", "--sign", "-", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    codesignOk = proc.exitCode === 0;
    if (!codesignOk) {
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      log.debug(`codesign on ${displayName} exited ${proc.exitCode}: ${stderr}`);
    }
  } catch (e) {
    log.debug(
      `codesign on ${displayName} threw: ${errorMessage(e)}`,
    );
  }
  try {
    // `xattr -d` returns exit 1 with "No such xattr" if the attribute is
    // already absent (e.g. the file was placed via `bun link` instead of
    // downloaded). That's a success outcome for our purposes — the
    // attribute we wanted gone is already gone — so treat exit 1 as ok.
    const proc = Bun.spawnSync(
      ["xattr", "-d", "com.apple.provenance", path],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    xattrOk =
      proc.exitCode === 0 ||
      (proc.exitCode === 1 && /No such xattr/i.test(stderr));
    if (!xattrOk) {
      log.debug(`xattr -d on ${displayName} exited ${proc.exitCode}: ${stderr}`);
    }
  } catch (e) {
    log.debug(
      `xattr -d on ${displayName} threw: ${errorMessage(e)}`,
    );
  }
  if (!codesignOk && !xattrOk) {
    // POSIX single-quote escape so spaces/metachars in the path don't break paste-into-shell.
    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    log.warn(
      `Could not unblock ${displayName} for macOS Gatekeeper (both codesign ` +
        `and xattr failed); if the binary refuses to run, manually run: ` +
        `codesign --force --sign - ${q(path)}  &&  xattr -d com.apple.provenance ${q(path)}`,
    );
  }
}

/**
 * Fetch a single Swift sidecar and place it next to the engine binary on
 * darwin-arm64. Best-effort: 404s (older engine versions predate this
 * sidecar) and network errors log a warning and return — the corresponding
 * feature simply won't be available. The user keeps everything else.
 */
async function downloadSidecar(
  spec: SidecarSpec,
  binPath: string,
  version: string,
): Promise<void> {
  if (!isDarwinArm64()) return;

  const sidecarPath = join(dirname(binPath), spec.fileBasename);
  const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${spec.assetName}`;

  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    log.warn(
      `Could not fetch ${spec.displayName} (${errorMessage(e)}); ${spec.unavailableHint}.`,
    );
    return;
  }

  if (!res.ok) {
    log.warn(
      `${spec.displayName} not in release v${version} (HTTP ${res.status}); ${spec.unavailableHint}.`,
    );
    return;
  }

  // Catch stream/chmod failures so a sidecar error can't poison the engine install.
  try {
    await streamResponseToFile(res, sidecarPath, spec.displayName);
    chmodSync(sidecarPath, 0o755);
    darwinTrustBinary(sidecarPath, spec.displayName);
    log.success(`${spec.displayName} installed (${spec.availableHint}).`);
  } catch (e) {
    log.warn(
      `${spec.displayName} install failed (${errorMessage(e)}); ${spec.unavailableHint}.`,
    );
  }
}

async function warmDarwinKokoro(binPath: string): Promise<void> {
  if (!isDarwinArm64()) return;
  // Kokoro now runs in-engine (FluidAudio CoreML, system_kokoro) — warm it by
  // exercising the engine's own `say`, not a sidecar. The first synthesis
  // compiles/fetches FluidAudio's CoreML Kokoro cache.
  if (!existsSync(binPath)) return;

  const outPath = join(tmpdir(), `kesha-kokoro-warmup-${process.pid}.wav`);
  log.progress("Warming FluidAudio Kokoro CoreML cache...");

  const startedAt = performance.now();
  const proc = Bun.spawn(
    [
      binPath,
      "say",
      "--voice",
      "en-am_michael",
      "--out",
      outPath,
      "Kesha warmup.",
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, 180_000);

  let stderr = "";
  try {
    const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
    const [stderrText, exitCode] = await Promise.all([
      new Response(stderrStream).text(),
      proc.exited,
    ]);
    stderr = stderrText.trim();

    if (timedOut) {
      log.warn("FluidAudio Kokoro warmup timed out; first `kesha say en-*` may still be slow.");
      return;
    }
    if (exitCode !== 0) {
      log.warn(
        `FluidAudio Kokoro warmup failed${stderr ? `: ${stderr}` : ""}; first ` +
          "`kesha say en-*` may still be slow.",
      );
      return;
    }

    log.success(
      `FluidAudio Kokoro warmed (${Math.round(performance.now() - startedAt)}ms).`,
    );
  } catch (e) {
    log.warn(
      `FluidAudio Kokoro warmup failed (${errorMessage(e)}); ` +
        "first `kesha say en-*` may still be slow.",
    );
  } finally {
    clearTimeout(timer);
    try {
      rmSync(outPath, { force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}

/** Build the `kesha-engine install` argv from options. Exported for testing. */
export function buildEngineInstallArgs(opts: {
  noCache: boolean;
  ttsLangs?: string[];
  vad?: boolean;
  diarize?: boolean;
}): string[] {
  return [
    "install",
    ...(opts.noCache ? ["--no-cache"] : []),
    ...(opts.ttsLangs && opts.ttsLangs.length > 0 ? ["--tts", ...opts.ttsLangs] : []),
    ...(opts.vad ? ["--vad"] : []),
    ...(opts.diarize ? ["--diarize"] : []),
  ];
}

export interface InstallOptions {
  /** TTS languages to install (empty/undefined = no TTS). */
  ttsLangs?: string[];
  /** Also install Silero VAD model for long-audio preprocessing. */
  vad?: boolean;
  /** Also install the Sortformer streaming-diarization model (~245MB,
   * darwin-arm64 only — see #199). */
  diarize?: boolean;
}

/**
 * Cache-valid path: the binary at binPath already matches the requested version.
 * Re-trusts it and tops up any sidecars the cached install is missing.
 */
async function refreshCachedEngine(
  binPath: string,
  canWriteEngineDir: boolean,
  noCache: boolean,
  version: string,
): Promise<void> {
  const engineDir = dirname(binPath);
  if (noCache && !canWriteEngineDir) {
    log.info(
      `Engine binary at v${version} is on a read-only filesystem; --no-cache skipped for engine (still forwarded to model installs).`,
    );
  } else {
    log.success(`Engine binary already installed (v${version}).`);
  }
  // Re-trust on cache hit: a user who upgraded to Sequoia after install would still have
  // com.apple.provenance attached; idempotent (~10ms no-op if already correct).
  if (canWriteEngineDir && existsSync(binPath)) {
    darwinTrustBinary(binPath, "kesha-engine binary");
  }
  // Top up missing sidecars (pre-#141/#199 cached binaries never had them);
  // skip on read-only fs (Nix-store) to avoid confusing "install failed" warnings.
  if (canWriteEngineDir) {
    const missing = SIDECARS.filter(
      (s) => !existsSync(join(engineDir, s.fileBasename)),
    );
    await Promise.all(missing.map((s) => downloadSidecar(s, binPath, version)));
    // Also re-trust already-present sidecars for the Sequoia upgrade scenario.
    for (const s of SIDECARS) {
      const p = join(engineDir, s.fileBasename);
      if (existsSync(p)) darwinTrustBinary(p, s.displayName);
    }
  }
}

/** EACCES/EPERM are deliberately absent: those are policy (noexec, ACL, AppLocker) and never clear. */
export function isTransientSpawnLock(message: string): boolean {
  return /\b(EBUSY|ETXTBSY)\b/.test(message) || /sharing violation/i.test(message);
}

/**
 * Blocks until the freshly-downloaded engine can actually be spawned.
 *
 * A security scanner (Windows Defender is the one this was found on) holds a lock on a newly
 * written 60 MB PE while it scans, so the first spawn fails with EBUSY 15 ms after the download
 * reported success (#216). The lock is transient, so probe until it clears.
 */
export async function waitUntilSpawnable(
  binPath: string,
  deadlineMs = 60_000,
  probeTimeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError = "";
  let warned = false;
  let delay = 100;

  for (;;) {
    try {
      // Only a throw means locked; the timeout is for a scanner that detains rather than refuses.
      const proc = Bun.spawn([binPath, "--version"], { stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => proc.kill(), probeTimeoutMs);
      try {
        await proc.exited;
      } finally {
        clearTimeout(timer);
      }
      return;
    } catch (e) {
      lastError = errorMessage(e);
      // Only a lock is worth waiting out — a missing or corrupt binary never becomes spawnable.
      if (!isTransientSpawnLock(lastError)) {
        throw new Error(
          `Downloaded the engine to ${binPath} but it could not be started: ${lastError}\n` +
            `  Fix: delete ${dirname(binPath)} and re-run \`kesha install\`.`,
        );
      }
      if (Date.now() + delay > deadline) break;
      if (!warned) {
        warned = true;
        log.progress("Waiting for the engine binary to be released by the system...");
      }
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }

  throw new Error(
    `Downloaded the engine to ${binPath} but it is still locked after ` +
      `${Math.round(deadlineMs / 1000)}s: ${lastError}\n` +
      `  Fix: a security scanner is likely holding the file. Re-run \`kesha install\`, ` +
      `or exclude ${dirname(binPath)} from real-time scanning.`,
  );
}

/**
 * Cache-validity health check: an install interrupted before `chmod`/marker-write, or a
 * binary from another architecture, exists at the right version yet cannot start (#770).
 */
async function engineRuns(binPath: string): Promise<boolean> {
  const health = await probeExecutable(binPath, ["--version"]);
  if (health.status === "ok") return true;
  const detail = health.status === "unusable" ? health.detail : "binary disappeared";
  log.warn(
    `Installed engine at ${binPath} does not run (${detail}); it is corrupt or built for ` +
      "another architecture — re-downloading it.",
  );
  return false;
}

/** Cold path: download the engine binary (and sidecars, concurrently). */
async function fetchEngineBinary(
  binPath: string,
  installedVersion: string | null,
  version: string,
): Promise<void> {
  // Log why we're downloading — helps diagnose surprising re-downloads.
  if (existsSync(binPath) && installedVersion && installedVersion !== version) {
    log.progress(
      `Replacing engine v${installedVersion} → v${version}...`,
    );
  }
  const binaryName = getEngineBinaryName();
  const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryName}`;

  mkdirSync(dirname(binPath), { recursive: true });

  // Overlap sidecar fetches with the engine fetch (~15-30s saved on cold install).
  const sidecarPromises = SIDECARS.map((s) =>
    downloadSidecar(s, binPath, version),
  );
  // If the engine fetch throws, silence in-flight sidecar rejections so unhandledRejection doesn't obscure the engine error.
  const muteSidecarRejections = () =>
    sidecarPromises.forEach((p) => p.catch(() => {}));

  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    muteSidecarRejections();
    throw new Error(
      `Failed to fetch engine binary: ${errorMessage(e)}\n  Fix: Check your network connection and try again`,
    );
  }

  if (!res.ok) {
    muteSidecarRejections();
    // Names the tag: nothing falls back to the pin, so the caller must see which release 404ed.
    throw new Error(
      `Failed to download engine binary from release v${version} (HTTP ${res.status})\n  Fix: Check https://github.com/${GITHUB_REPO}/releases for available versions`,
    );
  }

  await streamResponseToFile(res, binPath, "kesha-engine binary");
  chmodSync(binPath, 0o755);
  darwinTrustBinary(binPath, "kesha-engine binary");
  // Marker last: writing it first sends the retry down the cacheValid branch, which never waits.
  await waitUntilSpawnable(binPath);
  writeInstalledEngineVersion(binPath, version);
  log.success(`Engine binary downloaded (v${version}).`);
  await Promise.all(sidecarPromises);
}

/**
 * Returns true when the engine directory is writable by the current process.
 *
 * A false result indicates a read-only install (e.g. Nix store) — callers
 * should skip download/sidecar steps rather than emitting confusing errors.
 */
function checkEngineWritable(engineDir: string): boolean {
  if (!existsSync(engineDir)) return true; // dir will be created on cold install
  try {
    accessSync(engineDir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates that the installed engine matches the requested backend.
 * Throws if the engine advertises a different backend.
 */
function validateBackend(backend: string, caps: EngineCapabilities | null): void {
  if (caps && caps.backend !== backend) {
    throw new Error(
      `Requested backend "${backend}" is not available: the installed engine for this platform uses "${caps.backend}".\n  Fix: omit --${backend} to use the auto-detected backend, or run on a platform that ships the "${backend}" build.`,
    );
  }
}

/**
 * Guards against forwarding `--diarize` to an engine built without it.
 *
 * Catches the case where the platform check passed (darwin-arm64) but the
 * engine itself was built without `system_diarize` — e.g., the Nix build,
 * which compiles `coreml,tts,system_tts` and intentionally omits diarize
 * because the FluidAudio CoreML weights need network at build time and the
 * Nix sandbox forbids it. Without this guard, `kesha-engine install
 * --diarize` would fail with clap's generic "unexpected argument" error.
 */
function validateDiarize(caps: EngineCapabilities | null): void {
  // null = pre-capabilities-JSON engine; forwarding --diarize would surface as clap's "unexpected argument".
  if (!caps || !caps.features.includes(TRANSCRIBE_DIARIZE_FEATURE)) {
    throw new Error(
      "--diarize is not supported by the installed engine: it was built " +
        "without the 'system_diarize' feature (the Nix build is one such " +
        "case — see docs/nix-install.md).\n" +
        "  Fix: install via the npm release with `bun add -g @drakulavich/kesha-voice-kit`, " +
        "which ships the diarize-enabled engine on darwin-arm64.",
    );
  }
}

/**
 * Runs `kesha-engine install` to download/verify models.
 * Inherits stdio so per-file progress reaches the user live, and throws on non-zero exit.
 */
function runEngineModelInstall(
  binPath: string,
  noCache: boolean,
  options: InstallOptions,
): void {
  log.progress("Installing models...");
  const installArgs = buildEngineInstallArgs({
    noCache,
    ttsLangs: options.ttsLangs,
    vad: options.vad,
    diarize: options.diarize,
  });
  // #680: piping buffers the child until exit, so multi-GB downloads looked hung.
  const proc = Bun.spawnSync([binPath, ...installArgs], {
    stdout: "inherit",
    stderr: "inherit",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      `Failed to install models: kesha-engine install exited with code ${proc.exitCode}. ` +
        "See the engine output above for the failing file.",
    );
  }
}

export interface EngineInstallRequest extends InstallOptions {
  noCache?: boolean;
  backend?: string;
  /** Engine release to install; defaults to the Pinned Engine version and applies to this call only. */
  version?: string;
}

/**
 * Installs one Engine release plus its models.
 *
 * `version` is the single input for the release URL, the cache-validity comparison, the
 * sidecar downloads and the recorded `.version` marker — reading the pin at any one of
 * them would install the requested Engine and then replace it on the next cache check.
 */
export async function installEngine(request: EngineInstallRequest = {}): Promise<string> {
  const { noCache = false, backend, version = engineVersion, ...options } = request;
  const binPath = getEngineBinPath();
  const installedVersion = readInstalledEngineVersion(binPath);
  const engineDir = dirname(binPath);

  if (version !== engineVersion) {
    log.info(
      `Installing engine v${version} instead of the pinned v${engineVersion}; ` +
        "a later `kesha install` without --engine-version restores the pin.",
    );
  }

  // Read-only engine dir = Nix-store install; skip download/sidecar writes to avoid EROFS errors.
  const canWriteEngineDir = checkEngineWritable(engineDir);

  const markerMatches = existsSync(binPath) && installedVersion === version;
  // The marker vouches for a file, not for a working binary. Skipped on a read-only engine
  // dir: nothing there can be repaired, so a failed probe would only turn a usable Nix
  // install into a hard error.
  const versionMatches =
    markerMatches && (!canWriteEngineDir || (await engineRuns(binPath)));
  // On read-only fs, --no-cache can't re-download; treat as cache-valid and forward flag to model install.
  const cacheValid = versionMatches && (!noCache || !canWriteEngineDir);

  if (cacheValid) {
    await refreshCachedEngine(binPath, canWriteEngineDir, noCache, version);
  } else {
    if (!canWriteEngineDir) {
      throw new Error(
        `Cannot install engine v${version}: ${engineDir} is not writable ` +
          `(installed: ${installedVersion ? `v${installedVersion}` : "no recorded version"}).\n` +
          "  Fix: point KESHA_ENGINE_BIN at a writable path, or install into a writable prefix.",
      );
    }
    await fetchEngineBinary(binPath, installedVersion, version);
  }

  if (backend || options.diarize) {
    const caps = await getEngineCapabilities();
    if (backend) validateBackend(backend, caps);
    if (options.diarize) validateDiarize(caps);
  }

  runEngineModelInstall(binPath, noCache, options);

  // Warm the FluidAudio Kokoro CoreML cache only when a Kokoro language is
  // requested. Russian (`ru`) routes through Vosk-TTS, not Kokoro, so a
  // Russian-only install has nothing to warm.
  const wantsKokoro = (options.ttsLangs ?? []).some((l) => l !== "ru");
  if (wantsKokoro) {
    await warmDarwinKokoro(binPath);
  }

  if (canWriteEngineDir) {
    cleanupRetiredSidecars(engineDir);
  }

  log.success(`Backend installed successfully (engine v${version}).`);
  return binPath;
}

/** Installs the Pinned Engine version. Public API (`downloadModel`); the override is CLI-only. */
export async function downloadEngine(
  noCache = false,
  backend?: string,
  options: InstallOptions = {},
): Promise<string> {
  // Field-by-field, not a spread: a caller's stray `version` must not reach installEngine.
  return installEngine({
    noCache,
    backend,
    ttsLangs: options.ttsLangs,
    vad: options.vad,
    diarize: options.diarize,
  });
}
