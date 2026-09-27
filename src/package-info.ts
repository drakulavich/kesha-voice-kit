import pkg from "../package.json" with { type: "json" };
import type { AssetPins } from "./engine-install";

type PackageFields = { version?: unknown; kesha?: { engine?: unknown } };

function isAssetPins(value: unknown): value is AssetPins {
  const pins = value as { version?: unknown; sha256?: unknown } | null;
  return (
    typeof pins?.version === "string" &&
    typeof pins.sha256 === "object" &&
    pins.sha256 !== null &&
    Object.values(pins.sha256).every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))
  );
}

/** The Engine this CLI installs: the pin `release.yml` injects at publish, else the CLI's own version. */
export function resolveEngine(fields: PackageFields): { version: string; pins?: AssetPins } {
  const injected = fields.kesha?.engine;
  if (isAssetPins(injected)) return { version: injected.version, pins: injected };
  return { version: typeof fields.version === "string" ? fields.version : "unknown" };
}

const engine = resolveEngine(pkg as PackageFields);

export const packageName = typeof pkg.name === "string" ? pkg.name : "unknown";
export const packageVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
export const engineVersion = engine.version;
/** Undefined in a source checkout; the installer then falls back to the committed table. */
export const injectedEnginePins = engine.pins;
