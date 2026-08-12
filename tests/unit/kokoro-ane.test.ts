import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  KOKORO_ANE_EN_REQUIRED,
  KOKORO_G2P_REQUIRED,
  kokoroAneComponents,
} from "../../src/kokoro-ane";
import { collectDoctorReport } from "../../src/doctor";
import { renderInstallPlan } from "../../src/install-plan";

const DARWIN = { platform: "darwin", arch: "arm64" } as const;

function write(path: string, bytes = 4): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
}

function withHome(run: (home: string, cacheRoot: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "kesha-kokoro-ane-"));
  try {
    run(home, join(home, ".cache", "kesha"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function componentsIn(home: string, cacheRoot: string) {
  return kokoroAneComponents({ ...DARWIN, homeDir: home, cacheRoot });
}

function byLabel(home: string, cacheRoot: string) {
  return Object.fromEntries(componentsIn(home, cacheRoot).map((c) => [c.label, c]));
}

function stage(dir: string, required: readonly string[]): void {
  for (const entry of required) write(join(dir, entry));
}

const freshAne = (cacheRoot: string) =>
  join(cacheRoot, "fluidaudio", "kokoro-82m-coreml", "ANE");
const legacyAne = (home: string) =>
  join(home, ".cache", "fluidaudio", "Models", "kokoro-82m-coreml", "ANE");
const g2p = (home: string) => join(home, ".cache", "fluidaudio", "Models", "kokoro");

describe("kokoroAneComponents", () => {
  test("a machine that never installed TTS reports both sets absent", () => {
    withHome((home, cacheRoot) => {
      const components = componentsIn(home, cacheRoot);
      expect(components.map((c) => c.label)).toEqual([
        "TTS (Kokoro ANE)",
        "TTS (Kokoro G2P)",
      ]);
      expect(components.every((c) => !c.exists)).toBe(true);
      expect(components[0]!.missing).toEqual(KOKORO_ANE_EN_REQUIRED);
      expect(components[1]!.missing).toEqual(KOKORO_G2P_REQUIRED);
    });
  });

  test("a complete staging reports no missing entries", () => {
    withHome((home, cacheRoot) => {
      stage(freshAne(cacheRoot), KOKORO_ANE_EN_REQUIRED);
      stage(g2p(home), KOKORO_G2P_REQUIRED);

      for (const component of componentsIn(home, cacheRoot)) {
        expect(component.exists).toBe(true);
        expect(component.missing).toEqual([]);
        expect(component.sizeBytes).toBeGreaterThan(0);
      }
    });
  });

  // An interrupted `kesha install --tts` leaves a directory that exists and cannot
  // synthesize; naming the gap is what makes the row actionable (#831).
  test("a partial staging names exactly what is absent", () => {
    withHome((home, cacheRoot) => {
      stage(freshAne(cacheRoot), KOKORO_ANE_EN_REQUIRED.slice(1));
      stage(g2p(home), KOKORO_G2P_REQUIRED);

      const ane = byLabel(home, cacheRoot)["TTS (Kokoro ANE)"]!;
      expect(ane.exists).toBe(true);
      expect(ane.missing).toEqual([KOKORO_ANE_EN_REQUIRED[0]!]);
    });
  });

  // #688/#820: an install predating the relocation keeps its bundle, and doctor must
  // report the copy the engine actually reads rather than an empty cache path.
  test("assets left in the legacy FluidAudio tree are reported where they are", () => {
    withHome((home, cacheRoot) => {
      stage(legacyAne(home), KOKORO_ANE_EN_REQUIRED);

      const ane = byLabel(home, cacheRoot)["TTS (Kokoro ANE)"]!;
      expect(ane.path).toBe(legacyAne(home));
      expect(ane.missing).toEqual([]);
    });
  });

  // `G2PModel.shared` is an upstream singleton: no models root can move it, so it is
  // reported at the home-relative path on a fresh install too (#688).
  test("the G2P set stays at the pinned home path whatever the cache root is", () => {
    withHome((home, cacheRoot) => {
      expect(byLabel(home, cacheRoot)["TTS (Kokoro G2P)"]!.path).toBe(g2p(home));
    });
  });

  test("no ANE story on a platform whose engine has no FluidAudio", () => {
    withHome((home, cacheRoot) => {
      expect(
        kokoroAneComponents({ platform: "linux", arch: "x64", homeDir: home, cacheRoot }),
      ).toEqual([]);
    });
  });
});

// Retargeting one surface and not the other is what #828 declined to do: an install
// preview that contradicts doctor is worse than a consistent stale story (#831).
describe("doctor and `install --plan` tell the same Kokoro ANE story", () => {
  const darwinArmTest =
    process.platform === "darwin" && process.arch === "arm64" ? test : test.skip;

  darwinArmTest("both name the directories the shared resolver names", async () => {
    const home = mkdtempSync(join(tmpdir(), "kesha-kokoro-ane-agreement-"));
    const saved = { ...process.env };
    try {
      process.env.HOME = home;
      process.env.KESHA_CACHE_DIR = join(home, ".cache", "kesha");
      process.env.KESHA_ENGINE_BIN = join(home, "engine", "bin", "kesha-engine");
      process.env.KESHA_STATS_DB = join(home, "stats.sqlite");

      const paths = kokoroAneComponents().map((c) => c.path);
      expect(paths).toHaveLength(2);

      const report = await collectDoctorReport({ redact: false });
      const plan = await renderInstallPlan({ ttsLangs: ["en"] });
      for (const path of paths) {
        expect(report.optionalComponents.map((c) => c.path)).toContain(path);
        expect(plan).toContain(path);
      }
    } finally {
      for (const key of ["HOME", "KESHA_CACHE_DIR", "KESHA_ENGINE_BIN", "KESHA_STATS_DB"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// The staged set is written out in both languages; nothing else fails when only one side
// is edited, and a divergence makes doctor call an unusable install healthy (#831).
describe("Rust/TS Kokoro ANE manifest agreement", () => {
  const rust = readFileSync(join(import.meta.dir, "..", "..", "rust", "src", "models.rs"), "utf8");

  /** Top-level entries of a `models.rs` `ModelFile` manifest, the granularity doctor probes. */
  function stagedTopLevel(constName: string): string[] {
    const start = rust.indexOf(`const ${constName}: &[ModelFile] = &[`);
    expect(start).toBeGreaterThan(-1);
    const block = rust.slice(start, rust.indexOf("\n];", start));
    const paths = [...block.matchAll(/"([A-Za-z0-9_][A-Za-z0-9_./-]*)"/g)]
      .map((m) => m[1]!)
      .filter((p) => !/^[0-9a-f]{64}$/.test(p));
    return [...new Set(paths.map((p) => p.split("/")[0]!))].sort();
  }

  test("the English ANE chain matches models.rs::ANE_EN_FILES", () => {
    expect(stagedTopLevel("ANE_EN_FILES")).toEqual([...KOKORO_ANE_EN_REQUIRED].sort());
  });

  test("the shared G2P set matches models.rs::KOKORO_G2P_FILES", () => {
    expect(stagedTopLevel("KOKORO_G2P_FILES")).toEqual([...KOKORO_G2P_REQUIRED].sort());
  });

  // Both groups are staged by the same call; a rename there would strand the probe.
  test("both groups are still what `kesha install --tts` stages", () => {
    expect(rust).toContain("stage_into(&fluidaudio_ane_kokoro_dir()?, ANE_EN_FILES, no_cache)?;");
    expect(rust).toContain("stage_into(&fluidaudio_kokoro_g2p_dir()?, KOKORO_G2P_FILES, no_cache)?;");
    expect(rust).toContain(`fluidaudio_kokoro_cache_dir()?.join("ANE")`);
  });
});
