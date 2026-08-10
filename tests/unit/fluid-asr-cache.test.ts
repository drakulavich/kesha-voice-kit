import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import {
  FLUID_ASR_REQUIRED,
  fluidAsrCachePath,
  fluidAsrCacheReady,
  isCoremlBackend,
  legacyFluidAsrCachePath,
} from "../../src/fluid-asr-cache";
import { defaultBackendForPlatform, unavailableBackendError } from "../../src/cli/install";
import { isInsideDir } from "../../src/cache-layout";

describe("isCoremlBackend", () => {
  test("trusts the engine's reported backend over the host platform", () => {
    expect(isCoremlBackend("coreml", "linux", "x64")).toBe(true);
    expect(isCoremlBackend("onnx", "darwin", "arm64")).toBe(false);
  });

  // A failed probe must not point darwin at an ONNX dir it never populates (#684).
  test("falls back to the platform when the capabilities probe yields nothing", () => {
    expect(isCoremlBackend(undefined, "darwin", "arm64")).toBe(true);
    expect(isCoremlBackend(undefined, "darwin", "x64")).toBe(false);
    expect(isCoremlBackend(undefined, "linux", "x64")).toBe(false);
  });
});

describe("the FluidAudio ASR bundle", () => {
  // `Repo.folderName` strips the `-coreml` suffix, and a `…-v3-coreml` sibling exists
  // on disk. Reporting that one would call a healthy install broken.
  test("points at the directory FluidAudio loads from, not the -coreml sibling", () => {
    const path = legacyFluidAsrCachePath("/tmp/home");
    expect(path).toBe(
      join("/tmp/home", "Library", "Application Support", "FluidAudio", "Models", "parakeet-tdt-0.6b-v3"),
    );
    expect(path.endsWith("-coreml")).toBe(false);
  });

  const COMPLETE = [
    "Preprocessor.mlmodelc",
    "Encoder.mlmodelc",
    "Decoder.mlmodelc",
    "JointDecisionv3.mlmodelc",
    "parakeet_vocab.json",
  ];

  // `.mlmodelc` are compiled-model directories holding `coremldata.bin`, not flat files.
  function seed(homeDir: string, entries: string[]): string {
    const cache = legacyFluidAsrCachePath(homeDir);
    mkdirSync(cache, { recursive: true });
    for (const e of entries) {
      if (e.endsWith(".mlmodelc")) {
        mkdirSync(join(cache, e), { recursive: true });
        writeFileSync(join(cache, e, "coremldata.bin"), "compiled");
      } else {
        writeFileSync(join(cache, e), "{}");
      }
    }
    return cache;
  }

  test("reports the bundle on darwin-arm64 when it is complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-test-"));
    try {
      const cache = seed(dir, COMPLETE);

      expect(fluidAsrCachePath(dir, join(dir, "cache"))).toBe(cache);
      expect(fluidAsrCacheReady(cache)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The bridge calls downloadAndLoad with useInt8Encoder: true, so an int4-only bundle
  // is unusable — accepting it would pass preflight and let FluidAudio fetch int8.
  test("rejects an int4-only bundle, which an int8 loader cannot use", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-int4-"));
    try {
      seed(dir, [
        ...COMPLETE.filter((f) => f !== "Encoder.mlmodelc"),
        "EncoderInt4.mlmodelc",
      ]);
      expect(fluidAsrCacheReady(legacyFluidAsrCachePath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An interrupted fetch leaves the directory present but partial. Calling that
  // healthy lets preflight pass and FluidAudio finish the download mid-transcribe.
  test("reports a partial bundle as absent, not healthy", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-partial-"));
    try {
      seed(dir, ["Encoder.mlmodelc"]);
      expect(fluidAsrCacheReady(legacyFluidAsrCachePath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports an empty bundle directory as absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-bare-"));
    try {
      mkdirSync(legacyFluidAsrCachePath(dir), { recursive: true });
      expect(fluidAsrCacheReady(legacyFluidAsrCachePath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports absent rather than throwing when the bundle was never fetched", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-empty-"));
    try {
      expect(fluidAsrCacheReady(fluidAsrCachePath(dir, join(dir, "cache")))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Relocating a bundle FluidAudio already holds would re-download ~460 MB, so a complete
  // legacy copy wins and nothing moves (#688).
  test("keeps a complete legacy bundle where FluidAudio already put it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-legacy-"));
    try {
      const legacy = seed(dir, COMPLETE);
      expect(fluidAsrCachePath(dir, join(dir, "cache"))).toBe(legacy);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A fresh install has no legacy bundle, so the engine roots it under the Kesha cache.
  // Reporting the old path here would call every new install broken (#688).
  test("follows the engine into the Kesha cache when there is no legacy bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-fresh-"));
    try {
      const cacheRoot = join(dir, "cache");
      expect(fluidAsrCachePath(dir, cacheRoot)).toBe(
        join(cacheRoot, "fluidaudio", "parakeet-tdt-0.6b-v3"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `status --disk` and `doctor` both branch on this to decide whether the bundle is already
  // inside the cache total, and so whether calling it "external" is a double count (#688/#790).
  test("containment in the cache root tracks which location won", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-inside-"));
    try {
      const cacheRoot = join(dir, "cache");
      expect(isInsideDir(fluidAsrCachePath(dir, cacheRoot), cacheRoot)).toBe(true);

      seed(dir, COMPLETE);
      expect(isInsideDir(fluidAsrCachePath(dir, cacheRoot), cacheRoot)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});

describe("unavailableBackendError", () => {
  const saved = process.env.KESHA_ENGINE_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.KESHA_ENGINE_BIN;
    else process.env.KESHA_ENGINE_BIN = saved;
  });

  test("accepts an omitted backend and the platform's own", () => {
    delete process.env.KESHA_ENGINE_BIN;
    expect(unavailableBackendError(undefined)).toBeNull();
    expect(unavailableBackendError(defaultBackendForPlatform())).toBeNull();
  });

  // Gates both `install --plan` and `init --plan` against previewing a rejected install (#684).
  test("rejects a backend this platform does not ship", () => {
    delete process.env.KESHA_ENGINE_BIN;
    const other = defaultBackendForPlatform() === "coreml" ? "onnx" : "coreml";
    expect(unavailableBackendError(other)).toContain(other);
  });

  test("defers to a user-supplied engine", () => {
    process.env.KESHA_ENGINE_BIN = "/tmp/custom-engine";
    const other = defaultBackendForPlatform() === "coreml" ? "onnx" : "coreml";
    expect(unavailableBackendError(other)).toBeNull();
  });
});

// The bundle contract is hardcoded in both languages; nothing else fails when only one
// side is edited, and the int4 hole (#684) was exactly that kind of silent divergence.
describe("Rust/TS FluidAudio contract agreement", () => {
  const rust = readFileSync(
    join(import.meta.dir, "..", "..", "rust", "src", "models.rs"),
    "utf8",
  );

  function rustList(constName: string): string[] {
    const block = rust.match(new RegExp(`const ${constName}: &\\[&str\\] = &\\[([^\\]]*)\\]`));
    if (!block) throw new Error(`${constName} not found in rust/src/models.rs`);
    return [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  }

  // Reads the value, not the expression using it: matching `.join("…")` broke on refactors.
  function rustStr(constName: string): string {
    const block = rust.match(new RegExp(`const ${constName}: &str = "([^"]+)"`));
    if (!block) throw new Error(`${constName} not found in rust/src/models.rs`);
    return block[1]!;
  }

  test("required entry lists match", () => {
    expect(rustList("FLUID_ASR_REQUIRED").sort()).toEqual([...FLUID_ASR_REQUIRED].sort());
  });

  test("cache directory name matches", () => {
    expect(rustStr("FLUID_ASR_REPO_DIR")).toBe(basename(legacyFluidAsrCachePath("/tmp/home")));
  });

  // Both sides derive the relocated bundle from the cache root; a rename on one side alone
  // would point doctor at a directory the engine never writes (#688).
  test("relocated bundle path matches", () => {
    expect(fluidAsrCachePath("/tmp/home", "/tmp/cache")).toBe(
      join("/tmp/cache", rustStr("FLUIDAUDIO_ROOT_DIR"), rustStr("FLUID_ASR_REPO_DIR")),
    );
  });
});
