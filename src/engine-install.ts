import { dirname, join, resolve, sep } from "path";
import { errorMessage } from "./error-utils";
import { homedir, tmpdir } from "os";
import { existsSync, mkdirSync, chmodSync, accessSync, constants, rmSync } from "fs";
import {
  getEngineBinPath,
  getEngineCapabilities,
  TRANSCRIBE_DIARIZE_FEATURE,
  type EngineCapabilities,
} from "./engine";
import { engineFunctionalHealth, probeExecutable } from "./engine-health";
import { engineTarget, isDarwinArm64 } from "./engine-targets";
import { TS_NATIVE_CODES } from "./error-codes";
import { acquireInstallLock } from "./install-lock";
import { log } from "./log";
import { engineVersion } from "./package-info";
import { keshaCacheDir } from "./paths";
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

/** Best-effort; `alreadyDoneExit1` marks the exit-1 stderr that means the work was already done. */
function trustStep(
  argv: string[],
  label: string,
  displayName: string,
  alreadyDoneExit1?: RegExp,
): boolean {
  try {
    const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    const ok =
      proc.exitCode === 0 ||
      (proc.exitCode === 1 && alreadyDoneExit1 !== undefined && alreadyDoneExit1.test(stderr));
    if (!ok) log.debug(`${label} on ${displayName} exited ${proc.exitCode}: ${stderr}`);
    return ok;
  } catch (e) {
    log.debug(`${label} on ${displayName} threw: ${errorMessage(e)}`);
    return false;
  }
}

/**
 * Make a freshly-downloaded Mach-O runnable on macOS 15+ Sequoia.
 *
 * The release binaries ship `Signature=adhoc` (no Apple Developer ID), and an HTTPS download
 * into `~/.cache/...` carries a `com.apple.provenance` xattr. On Sequoia that combination is
 * SIGKILLed on first invocation (exit 137) before Rust's main runs, with no log line.
 *
 * Re-signing ad-hoc with the host identity and stripping the provenance xattr each unblock it
 * on their own in field reports, and `xattr` survives a machine with no `codesign` on PATH, so
 * both run. Linux/Windows never reach this function.
 */
function darwinTrustBinary(path: string, displayName: string): void {
  if (process.platform !== "darwin") return;
  const codesignOk = trustStep(
    ["codesign", "--force", "--sign", "-", path],
    "codesign",
    displayName,
  );
  // A file placed by `bun link` was never downloaded, so exit 1 "No such xattr" is the outcome we wanted.
  const xattrOk = trustStep(
    ["xattr", "-d", "com.apple.provenance", path],
    "xattr -d",
    displayName,
    /No such xattr/i,
  );
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
      // Resolves the voice from the Model cache, so it needs the same runtime
      // `KESHA_CACHE_DIR` the install itself was given (#876).
      env: process.env,
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
    // #768: speaker labels attach to VAD-windowed segments, so --diarize pulls VAD in.
    ...(opts.vad || opts.diarize ? ["--vad"] : []),
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

/** A sidecar that is present but unrunnable is as useless as an absent one, and `kesha install` is the repair (#770). */
async function sidecarNeedsDownload(spec: SidecarSpec, engineDir: string): Promise<boolean> {
  const health = await probeExecutable(join(engineDir, spec.fileBasename));
  if (health.status === "ok") return false;
  if (health.status === "unusable") {
    log.warn(
      `${spec.displayName} is installed but does not run (${health.detail}); re-downloading it.`,
    );
  }
  return true;
}

/**
 * Cache-valid path: the binary at binPath already matches the requested version.
 * Re-trusts it and re-fetches any sidecar the cached install is missing or cannot run.
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
  // Top up missing or broken sidecars (pre-#141/#199 cached binaries never had them);
  // skip on read-only fs (Nix-store) to avoid confusing "install failed" warnings.
  if (canWriteEngineDir) {
    await Promise.all(
      SIDECARS.map(async (spec) => {
        const path = join(engineDir, spec.fileBasename);
        // Re-trust before probing, for the Sequoia upgrade scenario: a provenance-blocked
        // sidecar is SIGKILLed on spawn, and re-downloading it would not lift the block.
        if (existsSync(path)) darwinTrustBinary(path, spec.displayName);
        if (await sidecarNeedsDownload(spec, engineDir)) {
          await downloadSidecar(spec, binPath, version);
        }
      }),
    );
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
 *
 * The probe is a full health check: a Gatekeeper-SIGKILLed binary spawns without throwing, and
 * accepting that would let the `.version` marker vouch for an engine that never ran (#770).
 */
export async function waitUntilSpawnable(binPath: string, deadlineMs = 60_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError = "";
  let warned = false;
  let delay = 100;

  for (;;) {
    const health = await probeExecutable(binPath, ["--version"]);
    if (health.status === "ok") return;
    lastError = health.status === "unusable" ? health.detail : "the binary is gone";
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

  throw new Error(
    `Downloaded the engine to ${binPath} but it is still locked after ` +
      `${Math.round(deadlineMs / 1000)}s: ${lastError}\n` +
      `  Fix: a security scanner is likely holding the file. Re-run \`kesha install\`, ` +
      `or exclude ${dirname(binPath)} from real-time scanning.`,
  );
}

/**
 * Cache-validity health check: an install interrupted before `chmod`/marker-write, or a
 * binary from another architecture, exists at the right version yet cannot start (#770) —
 * or starts and cannot describe itself, which is just as unusable (#801).
 */
async function engineWorks(binPath: string): Promise<boolean> {
  const health = await engineFunctionalHealth();
  if (health.status === "ok") return true;
  if (health.status === "mute") {
    log.warn(
      `Installed engine at ${binPath} runs but ${health.detail}; it is corrupt or truncated ` +
        "— re-downloading it.",
    );
    return false;
  }
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
export function validateDiarize(caps: EngineCapabilities | null): void {
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
  // `env` is load-bearing, not tidiness: this child resolves the model destination from
  // `KESHA_CACHE_DIR`, and without it Bun's startup snapshot sends a redirected install
  // to the real `~/.cache/kesha` anyway (#876).
  const proc = Bun.spawnSync([binPath, ...installArgs], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      `Failed to install models: kesha-engine install exited with code ${proc.exitCode}. ` +
        "See the engine output above for the failing file.",
    );
  }
}

/**
 * Refuses a test-run install that resolves to the developer's real engine cache (#796).
 *
 * Redirecting `KESHA_ENGINE_BIN`/`KESHA_CACHE_DIR` is opt-in per test, so a suite that forgets
 * it overwrites a real multi-GB install with a stub — and does it silently. Bun sets
 * `NODE_ENV=test` only under `bun test`, so this fires exactly there and nowhere else; the
 * refused location is always derived from `homedir()`, so an isolated cache never trips it.
 *
 * Both destinations are checked because different variables redirect them: an isolated
 * `KESHA_ENGINE_BIN` satisfied the binary half on its own while the models still downloaded
 * into the real cache (#876).
 */
export function assertNotRealCacheUnderTest(binPath: string): void {
  if (process.env.NODE_ENV !== "test") return;
  const realCache = resolve(join(homedir(), ".cache", "kesha"));
  const insideRealCache = (path: string): boolean => {
    const resolved = resolve(path);
    return resolved === realCache || resolved.startsWith(realCache + sep);
  };

  const offender = insideRealCache(binPath)
    ? { what: `install the engine into ${binPath}`, fix: "KESHA_ENGINE_BIN to a temp path" }
    : insideRealCache(keshaCacheDir())
      ? { what: `download models into ${keshaCacheDir()}`, fix: "KESHA_CACHE_DIR to a temp dir" }
      : null;
  if (!offender) return;

  throw new Error(
    `Refusing to ${offender.what} during a test run: that is the real ` +
      "per-user cache, and writing there destroys the developer's install (#796).\n" +
      "  Fix: call isolateEngineCache() from tests/helpers/fake-engine.ts in beforeEach, or set " +
      `${offender.fix}.\n` +
      "  If this is not a test run, unset NODE_ENV — Bun sets NODE_ENV=test under `bun test`.",
  );
}

/**
 * #997: exit 0 from `kesha install` has to mean the requested engine is the one on disk.
 * The lock covers concurrent CLI runs; this covers what it cannot — a manual cache edit, an
 * install that predates the lock, or a lock the filesystem refused to grant.
 */
function assertRequestedVersionLanded(binPath: string, version: string): void {
  const landed = readInstalledEngineVersion(binPath);
  if (landed === version && existsSync(binPath)) return;
  throw new Error(
    `error [${TS_NATIVE_CODES.INSTALL_RACE}]: installed engine v${version}, but ${dirname(binPath)} ` +
      `now holds ${landed ? `v${landed}` : "no recorded engine"} — something else wrote there ` +
      "during this install.\n" +
      `  Fix: re-run \`kesha install --engine-version ${version}\` once no other install is ` +
      "running against this cache (KESHA_CACHE_DIR / KESHA_ENGINE_BIN pick a private one).",
  );
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
  const binPath = getEngineBinPath();
  assertNotRealCacheUnderTest(binPath);
  const release = await acquireInstallLock(binPath);
  try {
    return await installLockedEngine(binPath, request);
  } finally {
    release();
  }
}

async function installLockedEngine(
  binPath: string,
  request: EngineInstallRequest,
): Promise<string> {
  const { noCache = false, backend, version = engineVersion, ...options } = request;
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
    markerMatches && (!canWriteEngineDir || (await engineWorks(binPath)));
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

  assertRequestedVersionLanded(binPath, version);
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
