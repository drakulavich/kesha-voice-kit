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
    sizeBytes: 62_172_768,
  },
  "linux-x64": {
    assetName: "kesha-engine-linux-x64",
    backend: "onnx",
    sizeBytes: 63_188_728,
  },
  "win32-x64": {
    assetName: "kesha-engine-windows-x64.exe",
    backend: "onnx",
    sizeBytes: 63_447_040,
  },
};

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
