import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  FLUID_ASR_REQUIRED,
  fluidAsrCacheInfo,
  fluidAsrCachePath,
  isCoremlBackend,
} from "../../src/fluid-asr-cache";
import { defaultBackendForPlatform, unavailableBackendError } from "../../src/cli/install";

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

describe("fluidAsrCacheInfo", () => {
  // `Repo.folderName` strips the `-coreml` suffix, and a `…-v3-coreml` sibling exists
  // on disk. Reporting that one would call a healthy install broken.
  test("points at the directory FluidAudio loads from, not the -coreml sibling", () => {
    const path = fluidAsrCachePath("/tmp/home");
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
    const cache = fluidAsrCachePath(homeDir);
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

      const info = fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir });

      expect(info.supported).toBe(true);
      expect(info.path).toBe(cache);
      expect(info.exists).toBe(true);
      expect(info.sizeBytes).toBeGreaterThan(0);
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
      expect(fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir }).exists).toBe(
        false,
      );
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
      expect(fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir }).exists).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports an empty bundle directory as absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-bare-"));
    try {
      mkdirSync(fluidAsrCachePath(dir), { recursive: true });
      expect(fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir }).exists).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports absent rather than throwing when the bundle was never fetched", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-fluid-asr-cache-empty-"));
    try {
      const info = fluidAsrCacheInfo({ platform: "darwin", arch: "arm64", homeDir: dir });
      expect(info.supported).toBe(true);
      expect(info.exists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stays inert off darwin-arm64, where the ONNX path is the real one", () => {
    const info = fluidAsrCacheInfo({ platform: "linux", arch: "x64", homeDir: "/tmp/home" });
    expect(info.supported).toBe(false);
    expect(info.exists).toBe(false);
    expect(info.sizeBytes).toBe(0);
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

  test("required entry lists match", () => {
    expect(rustList("FLUID_ASR_REQUIRED").sort()).toEqual([...FLUID_ASR_REQUIRED].sort());
  });

  test("cache directory name matches", () => {
    const leaf = fluidAsrCachePath("/tmp/home").split("/").pop();
    expect(rust).toContain(`.join("${leaf}")`);
  });
});
