/**
 * The one table of what each shipped platform gets.
 *
 * Kept import-free so any module can read it — `paths.ts` in particular must stay
 * dependency-light. Adding a platform is one row here; #216 had to touch four
 * separate switch chains, and nothing would have caught a missed one.
 */
export interface EngineTarget {
  /** GitHub release asset name — suffixed for uniqueness across platforms. */
  assetName: string;
  backend: "coreml" | "onnx";
}

const ENGINE_TARGETS: Record<string, EngineTarget> = {
  "darwin-arm64": {
    assetName: "kesha-engine-darwin-arm64",
    backend: "coreml",
  },
  "linux-x64": {
    assetName: "kesha-engine-linux-x64",
    backend: "onnx",
  },
  "win32-x64": {
    assetName: "kesha-engine-windows-x64.exe",
    backend: "onnx",
  },
};

/** Sidecar spec — centralises AVSpeech (#141) and future sidecars so each is one entry. */
export interface SidecarSpec {
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

/** Every asset `kesha install` downloads, and so every asset a published CLI's Engine pin covers. */
export function downloadedAssetNames(): string[] {
  return [...Object.values(ENGINE_TARGETS).map((t) => t.assetName), ...SIDECARS.map((s) => s.assetName)];
}

/** Asset name to SHA-256 from a release's `sha256sum`-format SHA256SUMS, whose names carry a `./` prefix. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *]?(?:\.\/)?(\S.*)$/.exec(line.trim());
    if (m) sums.set(m[2]!, m[1]!);
  }
  return sums;
}

/**
 * The one target whose engine links FluidAudio, so the only one with ANE Kokoro assets,
 * Swift sidecars and diarization. Kept beside the target table because that is what makes
 * it true — no build for another key ships those features.
 */
export function isDarwinArm64(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === "darwin" && arch === "arm64";
}

export function targetKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

/** Returns null for a platform with no published engine — callers choose how loudly to fail. */
export function engineTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): EngineTarget | null {
  return ENGINE_TARGETS[`${platform}-${arch}`] ?? null;
}

export function engineTargetEntries(): Array<{ platform: string; arch: string; target: EngineTarget }> {
  return Object.entries(ENGINE_TARGETS).map(([key, target]) => {
    // Split once from the left: an arch token may itself contain a hyphen, a platform never does.
    const sep = key.indexOf("-");
    return { platform: key.slice(0, sep), arch: key.slice(sep + 1), target };
  });
}
