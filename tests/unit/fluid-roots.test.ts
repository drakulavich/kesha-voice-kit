import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  fluidExternalRoots,
  fluidExternalTotalBytes,
  fluidLegacyRootPaths,
  fluidSubsystemDirs,
} from "../../src/fluid-roots";
import { FLUID_ASR_REQUIRED } from "../../src/fluid-asr-cache";
import { rustModelsSource } from "../helpers/rust-models-source";

function write(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
}

function withHome(run: (home: string, cacheRoot: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "kesha-fluid-roots-"));
  try {
    run(home, join(home, ".cache", "kesha"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const legacy = {
  asr: (home: string) =>
    join(home, "Library", "Application Support", "FluidAudio", "Models", "parakeet-tdt-0.6b-v3"),
  ane: (home: string) => join(home, ".cache", "fluidaudio", "Models", "kokoro-82m-coreml"),
  g2p: (home: string) => join(home, ".cache", "fluidaudio", "Models", "kokoro"),
  vad: (home: string) =>
    join(home, "Library", "Application Support", "FluidAudio", "Models", "silero-vad"),
  sortformer: (home: string) =>
    join(home, "Library", "Application Support", "fluidaudio-rs", "SortformerCompiled"),
};

function writeCompleteAsr(dir: string, bytesPerFile = 10): void {
  for (const file of FLUID_ASR_REQUIRED) write(join(dir, file), bytesPerFile);
}

function dirsByLabel(home: string, cacheRoot: string): Record<string, string> {
  return Object.fromEntries(
    fluidSubsystemDirs({ homeDir: home, cacheRoot }).map((s) => [s.label, s.path]),
  );
}

describe("fluidSubsystemDirs", () => {
  test("an install predating #688 keeps every subsystem in its legacy directory", () => {
    withHome((home, cacheRoot) => {
      writeCompleteAsr(legacy.asr(home));
      write(join(legacy.ane(home), "bundle.bin"), 100);
      write(join(legacy.g2p(home), "g2p_vocab.json"), 30);
      write(join(legacy.sortformer(home), "compiled.bin"), 200);
      write(join(legacy.vad(home), "model.mlmodelc"), 5);

      const resolved = fluidSubsystemDirs({ homeDir: home, cacheRoot });
      expect(resolved.every((s) => !s.inCache)).toBe(true);
      expect(dirsByLabel(home, cacheRoot)).toEqual({
        "ASR (Parakeet)": legacy.asr(home),
        "VAD (Silero, FluidAudio)": legacy.vad(home),
        "TTS (Kokoro ANE)": legacy.ane(home),
        "TTS (Kokoro G2P)": legacy.g2p(home),
        "Diarization (Sortformer)": legacy.sortformer(home),
      });
    });
  });

  test("a fresh install roots every relocatable subsystem under the cache", () => {
    withHome((home, cacheRoot) => {
      const byLabel = dirsByLabel(home, cacheRoot);
      expect(byLabel["ASR (Parakeet)"]).toBe(join(cacheRoot, "fluidaudio", "parakeet-tdt-0.6b-v3"));
      expect(byLabel["TTS (Kokoro ANE)"]).toBe(join(cacheRoot, "fluidaudio", "kokoro-82m-coreml"));
      expect(byLabel["Diarization (Sortformer)"]).toBe(
        join(cacheRoot, "fluidaudio", "fluidaudio-rs", "SortformerCompiled"),
      );
    });
  });

  // `G2PModel.shared` is an upstream singleton pinned to this path, so it is external on
  // every machine — a total that omits it is wrong even on a fresh install (#688).
  test("the Kokoro G2P assets stay outside the cache even on a fresh install", () => {
    withHome((home, cacheRoot) => {
      const g2p = fluidSubsystemDirs({ homeDir: home, cacheRoot }).find(
        (s) => s.label === "TTS (Kokoro G2P)",
      );
      expect(g2p?.path).toBe(legacy.g2p(home));
      expect(g2p?.inCache).toBe(false);
    });
  });

  test("a machine split across both layouts resolves each subsystem on its own", () => {
    withHome((home, cacheRoot) => {
      writeCompleteAsr(legacy.asr(home));
      write(join(legacy.sortformer(home), "compiled.bin"), 200);

      const byLabel = dirsByLabel(home, cacheRoot);
      expect(byLabel["ASR (Parakeet)"]).toBe(legacy.asr(home));
      expect(byLabel["Diarization (Sortformer)"]).toBe(legacy.sortformer(home));
      expect(byLabel["TTS (Kokoro ANE)"]).toBe(join(cacheRoot, "fluidaudio", "kokoro-82m-coreml"));
    });
  });

  test("an interrupted legacy ASR fetch does not pin the bundle in place", () => {
    withHome((home, cacheRoot) => {
      for (const file of FLUID_ASR_REQUIRED.slice(1)) write(join(legacy.asr(home), file), 10);
      expect(dirsByLabel(home, cacheRoot)["ASR (Parakeet)"]).toBe(
        join(cacheRoot, "fluidaudio", "parakeet-tdt-0.6b-v3"),
      );
    });
  });

  // Mirrors `models.rs::dir_has_entries`: keeping a legacy directory in use costs nothing,
  // re-downloading ~800 MB of ANE bundles costs a lot (#688).
  test("any entry at all pins the Kokoro and Sortformer caches in place", () => {
    withHome((home, cacheRoot) => {
      write(join(legacy.ane(home), "stray"), 1);
      write(join(legacy.sortformer(home), "stray"), 1);

      const byLabel = dirsByLabel(home, cacheRoot);
      expect(byLabel["TTS (Kokoro ANE)"]).toBe(legacy.ane(home));
      expect(byLabel["Diarization (Sortformer)"]).toBe(legacy.sortformer(home));
    });
  });
});

describe("fluidExternalRoots", () => {
  test("a machine with no FluidAudio tree reports nothing", () => {
    withHome((home, cacheRoot) => {
      expect(fluidExternalRoots({ homeDir: home, cacheRoot })).toEqual([]);
      expect(fluidExternalTotalBytes([])).toBe(0);
    });
  });

  test("every legacy root that holds bytes is reported with its in-use subsystems", () => {
    withHome((home, cacheRoot) => {
      writeCompleteAsr(legacy.asr(home));
      write(join(legacy.ane(home), "bundle.bin"), 100);
      write(join(legacy.g2p(home), "g2p_vocab.json"), 30);
      write(join(legacy.sortformer(home), "compiled.bin"), 200);

      const roots = fluidExternalRoots({ homeDir: home, cacheRoot });
      expect(roots.map((r) => r.path)).toEqual(fluidLegacyRootPaths(home));
      expect(roots.map((r) => r.sizeBytes)).toEqual([50, 130, 200]);
      expect(roots.map((r) => r.subsystems.map((s) => s.label))).toEqual([
        ["ASR (Parakeet)"],
        ["TTS (Kokoro ANE)", "TTS (Kokoro G2P)"],
        ["Diarization (Sortformer)"],
      ]);
      expect(fluidExternalTotalBytes(roots)).toBe(380);
    });
  });

  test("a root the engine no longer reads is still counted, with no subsystem named", () => {
    withHome((home, cacheRoot) => {
      // A relocated install: the bundle the engine reads is in the cache, the old copy is not.
      writeCompleteAsr(join(cacheRoot, "fluidaudio", "parakeet-tdt-0.6b-v3"));
      write(join(legacy.asr(home), "Encoder.mlmodelc", "model.mil"), 40);

      const roots = fluidExternalRoots({ homeDir: home, cacheRoot });
      expect(roots).toHaveLength(1);
      expect(roots[0]!.subsystems).toEqual([]);
      expect(roots[0]!.otherBytes).toBe(40);
      expect(roots[0]!.sizeBytes).toBe(40);
    });
  });

  test("a bundle present in both layouts is named once, at the copy the engine reads", () => {
    withHome((home, cacheRoot) => {
      writeCompleteAsr(legacy.asr(home));
      writeCompleteAsr(join(cacheRoot, "fluidaudio", "parakeet-tdt-0.6b-v3"), 999);

      const roots = fluidExternalRoots({ homeDir: home, cacheRoot });
      expect(roots).toHaveLength(1);
      expect(roots[0]!.subsystems).toEqual([
        { label: "ASR (Parakeet)", path: legacy.asr(home), sizeBytes: 50 },
      ]);
      expect(fluidExternalTotalBytes(roots)).toBe(50);
    });
  });

  // FluidAudio's own download leftovers are real bytes in a root Kesha created, so a total
  // that drops them is not the honest one. The `…-v3-coreml` sibling is genuinely orphaned;
  // silero-vad is not, and must not be lumped in with it.
  test("bytes no subsystem accounts for are reported as residue, not dropped", () => {
    withHome((home, cacheRoot) => {
      writeCompleteAsr(legacy.asr(home));
      const root = join(home, "Library", "Application Support", "FluidAudio");
      write(join(root, "Models", "parakeet-tdt-0.6b-v3-coreml", "Encoder.mlmodelc"), 70);
      write(join(root, "Models", "silero-vad", "model.mlmodelc"), 5);

      const roots = fluidExternalRoots({ homeDir: home, cacheRoot });
      expect(roots[0]!.sizeBytes).toBe(125);
      expect(roots[0]!.subsystems.map((s) => s.label)).toEqual([
        "ASR (Parakeet)",
        "VAD (Silero, FluidAudio)",
      ]);
      expect(roots[0]!.otherBytes).toBe(70);
    });
  });

  // The bridge passes no directory for VAD, so FluidAudio keeps its own copy here whatever
  // the models root is — calling it unread would invite deleting a model still in use (#688).
  test("FluidAudio's own VAD copy is named, and stays external on a fresh install", () => {
    withHome((home, cacheRoot) => {
      const vad = join(
        home,
        "Library",
        "Application Support",
        "FluidAudio",
        "Models",
        "silero-vad",
      );
      write(join(vad, "model.mlmodelc"), 12);

      const resolved = fluidSubsystemDirs({ homeDir: home, cacheRoot }).find(
        (s) => s.label === "VAD (Silero, FluidAudio)",
      );
      expect(resolved?.path).toBe(vad);
      expect(resolved?.inCache).toBe(false);
      expect(fluidExternalRoots({ homeDir: home, cacheRoot })[0]!.otherBytes).toBe(0);
    });
  });

  // #790: containment decides whether bytes are already inside the cache total.
  test("a legacy root that lives inside the cache root is left to the cache total", () => {
    withHome((home) => {
      write(join(legacy.ane(home), "bundle.bin"), 100);
      expect(fluidExternalRoots({ homeDir: home, cacheRoot: home })).toEqual([]);
    });
  });
});

// The resolution rule is written out in both languages; nothing else fails when only one
// side is edited, and a divergence here silently re-downloads gigabytes (#688).
describe("Rust/TS FluidAudio root agreement", () => {
  const rust = rustModelsSource();

  test("relocated subpaths match models.rs", () => {
    withHome((home, cacheRoot) => {
      const byLabel = dirsByLabel(home, cacheRoot);
      for (const [subpath, label] of [
        ["kokoro-82m-coreml", "TTS (Kokoro ANE)"],
        ["fluidaudio-rs/SortformerCompiled", "Diarization (Sortformer)"],
      ] as const) {
        expect(rust).toContain(`fluidaudio_location(&legacy, `);
        expect(rust).toContain(`, "${subpath}")`);
        expect(byLabel[label]).toBe(join(cacheRoot, "fluidaudio", ...subpath.split("/")));
      }
    });
  });

  test("legacy directory names match models.rs", () => {
    expect(rust).toContain(`.join("kokoro-82m-coreml")`);
    expect(rust).toContain(`.join("SortformerCompiled")`);
    expect(rust).toContain(`.join("fluidaudio-rs")`);
  });

  // Which probe each subsystem uses is the contract: strong for ASR, weak everywhere else.
  test("each subsystem uses the same probe strength as models.rs", () => {
    expect(rust).toContain("let complete = fluidaudio_asr_ready_in(&legacy);");
    expect(rust).toContain("let staged = dir_has_entries(&legacy);");
    expect(rust).toContain("let compiled = dir_has_entries(&legacy);");
  });
});
