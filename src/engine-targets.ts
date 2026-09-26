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
  /** Published asset size, for `kesha install --plan`. Verified by `check:engine-targets`. */
  sizeBytes: number;
}

const ENGINE_TARGETS: Record<string, EngineTarget> = {
  "darwin-arm64": {
    assetName: "kesha-engine-darwin-arm64",
    backend: "coreml",
    sizeBytes: 64_713_088,
  },
  "linux-x64": {
    assetName: "kesha-engine-linux-x64",
    backend: "onnx",
    sizeBytes: 66_588_184,
  },
  "win32-x64": {
    assetName: "kesha-engine-windows-x64.exe",
    backend: "onnx",
    sizeBytes: 65_587_712,
  },
};

/**
 * SHA-256 of every asset `kesha install` downloads from the pinned engine release: the three
 * engines and the darwin-arm64 sidecars. The installer refuses a download that hashes to
 * anything else, as the model manifest does (#174). `check:engine-targets` verifies them against
 * the release's SHA256SUMS, and the post-release follow-up rewrites them.
 */
export const PINNED_ASSET_SHA256: Readonly<Record<string, string>> = {
  "kesha-engine-darwin-arm64": "8244953e1bd37941c0ea18b2e2432cfe1cae71160bb79fd88b605f27707140b9",
  "kesha-engine-linux-x64": "1bb1ec4eafb99680374402206307ecf7cbc1b6ebc2f06dc0af74f7c5e848a553",
  "kesha-engine-windows-x64.exe": "1b0c9b8d3d2d284115ad9f1ba0571a1e52495413445b140ac5cc539db6a8c998",
  "say-avspeech-darwin-arm64": "a3aa5b75ddff68a48f1158e838310b37cac72ef86841d9cfcdf1ee233cb7451a",
  "kesha-textlang-darwin-arm64": "e45e2822248b14dd72aa79e2def8fa6b9c07c97423f11c841508769225d72da4",
};

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
