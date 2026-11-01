import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildUninstallPlan } from "../../src/uninstall-plan";
import { tempDir } from "../helpers/temp-dir";

const tempHome = (name: string): string => tempDir(`kesha-uninstall-${name}-`);

function put(path: string, bytes = 3): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
}

function plan(home: string, env: Record<string, string> = {}, platform = process.platform) {
  return buildUninstallPlan({ env: { HOME: home, ...env }, platform, homeDir: home, tmpDir: join(home, "tmp"), cwd: home });
}

const removed = (p: ReturnType<typeof plan>) => p.entries.filter((e) => e.action === "remove").map((e) => e.path);
const kept = (p: ReturnType<typeof plan>) => p.entries.filter((e) => e.action === "keep").map((e) => e.path);

describe("buildUninstallPlan", () => {
  test.skipIf(process.platform === "win32")(
    "a default macOS install lists every Kesha location, recordings included (the darwin layout needs POSIX paths)",
    () => {
      const home = tempHome("default");
      const cache = join(home, ".cache", "kesha");
      put(join(cache, "engine", "bin", "kesha-engine"), 10);
      put(join(cache, "models", "parakeet", "model.onnx"), 20);
      put(join(cache, "recordings", "live-1.wav"), 7);
      put(join(home, "Library", "Logs", "kesha", "kesha.ndjson"));
      put(join(home, "Library", "Logs", "kesha", "kesha.2.ndjson"));
      put(join(home, "Library", "Logs", "kesha", "diagnostic-logs.json"));
      put(join(home, "Library", "Application Support", "kesha", "stats.sqlite"));
      put(join(home, "tmp", "kesha-mcp", "0b6c5a1e-2f7d-4c1a-9e3b-5d8f7a6c4b21.ogg"));
      put(join(home, "Library", "Application Support", "FluidAudio", "Models", "silero-vad", "vad.mlmodelc"));
      put(join(home, ".cache", "fluidaudio", "Models", "kokoro", "g2p.bin"));

      const p = plan(home, {}, "darwin");

      expect(removed(p).sort()).toEqual(
        [
          join(cache, "engine"),
          join(cache, "models"),
          join(cache, "recordings"),
          join(home, "Library", "Logs", "kesha", "kesha.ndjson"),
          join(home, "Library", "Logs", "kesha", "kesha.2.ndjson"),
          join(home, "Library", "Logs", "kesha", "diagnostic-logs.json"),
          join(home, "Library", "Application Support", "kesha", "stats.sqlite"),
          join(home, "tmp", "kesha-mcp", "0b6c5a1e-2f7d-4c1a-9e3b-5d8f7a6c4b21.ogg"),
          join(home, "Library", "Application Support", "FluidAudio", "Models", "silero-vad"),
          join(home, ".cache", "fluidaudio", "Models", "kokoro"),
        ].sort(),
      );
      expect(p.entries.find((e) => e.path === join(cache, "recordings"))?.bytes).toBe(7);
      expect(kept(p)).toEqual([]);
      expect(p.engineBin).toBe(join(cache, "engine", "bin", "kesha-engine"));
    },
  );

  test.skipIf(process.platform !== "win32")(
    "a default Windows install lists the AppData locations and their kesha parents (the win32 layout needs win32 paths)",
    () => {
      const home = tempHome("windows");
      const local = join(home, "AppData", "Local", "kesha");
      const roaming = join(home, "AppData", "Roaming", "kesha");
      put(join(home, ".cache", "kesha", "engine", "bin", "kesha-engine.exe"));
      put(join(local, "logs", "kesha.ndjson"));
      put(join(roaming, "stats.sqlite"));

      const p = plan(home, {}, "win32");

      expect(removed(p).sort()).toEqual([join(home, ".cache", "kesha", "engine"), join(local, "logs", "kesha.ndjson"), join(roaming, "stats.sqlite")].sort());
      expect(p.emptyDirs).toContain(local);
      expect(p.emptyDirs).toContain(roaming);
      expect(p.engineBin).toBe(join(home, ".cache", "kesha", "engine", "bin", "kesha-engine.exe"));
    },
  );

  test("KESHA_HOME plus KESHA_LOG_DIR removes the Stats journal and leaves both roots to the empty-directory pass", () => {
    const home = tempHome("relocated");
    const keshaHome = join(home, "kesha-ci");
    const logDir = join(home, "var-log-kesha");
    put(join(keshaHome, "cache", "models", "m.onnx"));
    put(join(keshaHome, "stats.sqlite"));
    put(join(keshaHome, "stats.sqlite-wal"), 9);
    put(join(keshaHome, "stats.sqlite-shm"));
    put(join(keshaHome, "mcp-audio", "11111111-2222-4333-8444-555555555555.wav"));
    put(join(logDir, "kesha.ndjson"));

    const p = plan(home, { KESHA_HOME: keshaHome, KESHA_LOG_DIR: logDir });

    expect(removed(p).sort()).toEqual(
      [
        join(keshaHome, "cache", "models"),
        join(keshaHome, "stats.sqlite"),
        join(keshaHome, "stats.sqlite-wal"),
        join(keshaHome, "stats.sqlite-shm"),
        join(keshaHome, "mcp-audio", "11111111-2222-4333-8444-555555555555.wav"),
        join(logDir, "kesha.ndjson"),
      ].sort(),
    );
    expect(p.entries.find((e) => e.path.endsWith("stats.sqlite-wal"))?.bytes).toBe(9);
    expect(p.emptyDirs).toContain(keshaHome);
    expect(p.emptyDirs).toContain(logDir);
    expect(p.emptyDirs.indexOf(join(keshaHome, "mcp-audio"))).toBeLessThan(p.emptyDirs.indexOf(keshaHome));
    expect(kept(p)).toEqual([]);
  });

  test("KESHA_LOG_DIR at a shared directory removes only the Kesha log files and keeps the rest", () => {
    const home = tempHome("shared-log");
    put(join(home, "kesha.ndjson"));
    put(join(home, "kesha.1.ndjson"));
    put(join(home, "diary.txt"), 5);
    put(join(home, "kesha-notes.ndjson"));

    const p = plan(home, { KESHA_LOG_DIR: home });

    expect(removed(p).sort()).toEqual([join(home, "kesha.1.ndjson"), join(home, "kesha.ndjson")]);
    expect(kept(p)).toContain(join(home, "diary.txt"));
    expect(kept(p)).toContain(join(home, "kesha-notes.ndjson"));
    expect(p.entries.find((e) => e.path === join(home, "diary.txt"))?.bytes).toBe(5);
  });

  test("a planted file in the Model cache is kept and named, the recovery recording next to it is removed", () => {
    const home = tempHome("planted");
    const cache = join(home, ".cache", "kesha");
    put(join(cache, "recordings", "live-1.wav"));
    put(join(cache, "notes.txt"), 4);

    const p = plan(home);

    expect(removed(p)).toEqual([join(cache, "recordings")]);
    expect(p.entries.find((e) => e.path === join(cache, "notes.txt"))).toEqual({
      path: join(cache, "notes.txt"),
      label: "Not Kesha's",
      bytes: 4,
      action: "keep",
      reason: "not created by Kesha",
    });
  });

  test("another app's model in a shared FluidAudio root is kept and the partial legacy Parakeet is removed", () => {
    const home = tempHome("fluid");
    const models = join(home, "Library", "Application Support", "FluidAudio", "Models");
    put(join(models, "parakeet-tdt-0.6b-v3", "Encoder.mlmodelc", "weights.bin"));
    put(join(models, "parakeet-tdt-0.6b-v3-coreml", "Decoder.mlmodelc", "weights.bin"));
    put(join(models, "other-model", "weights.bin"), 6);

    const p = plan(home);

    expect(removed(p).sort()).toEqual([join(models, "parakeet-tdt-0.6b-v3"), join(models, "parakeet-tdt-0.6b-v3-coreml")]);
    expect(kept(p)).toEqual([join(models, "other-model")]);
    expect(p.entries.find((e) => e.action === "keep")?.bytes).toBe(6);
  });

  test("an entry that holds a kept file is kept itself, so rm -rf cannot take that file along", () => {
    const home = tempHome("keep-wins");
    const models = join(home, ".cache", "kesha", "models");
    const logDir = join(models, "logs");
    put(join(models, "asr", "model.onnx"));
    put(join(logDir, "kesha.ndjson"));
    put(join(logDir, "notes.txt"));

    const p = plan(home, { KESHA_LOG_DIR: logDir });

    expect(p.entries.find((e) => e.path === models)).toMatchObject({ action: "keep", reason: "holds files Kesha did not create" });
    expect(kept(p)).toContain(join(logDir, "notes.txt"));
    expect(removed(p)).toEqual([join(logDir, "kesha.ndjson")]);
  });

  test("an Engine that KESHA_ENGINE_BIN points at outside the Model cache is kept", () => {
    const home = tempHome("custom-engine");
    const engine = join(home, "opt", "kesha", "kesha-engine");
    put(engine);

    const p = plan(home, { KESHA_ENGINE_BIN: engine });

    expect(p.engineBin).toBe(engine);
    expect(p.entries).toEqual([{ path: engine, label: "Not Kesha's", bytes: 3, action: "keep", reason: "KESHA_ENGINE_BIN outside the Model cache" }]);
  });

  test("nothing installed yields an empty plan", () => {
    const home = tempHome("empty");

    expect(plan(home).entries).toEqual([]);
  });
});
