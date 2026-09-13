import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { writeTranscribingEngine } from "../helpers/fake-engine";
import { tempDir } from "../helpers/temp-dir";
import { runCliScenario } from "./cli-scenario";

const scenarioTest = process.platform === "win32" ? test.skip : test;

describe("engine debug events reach the diagnostic log (Exploratory S9-F5)", () => {
  scenarioTest("a structured debug event becomes a content-free engine.debug line", async () => {
    const dir = tempDir("kesha-engine-debug-log-");
    const home = join(dir, "state");
    const enginePath = writeTranscribingEngine(
      "kesha-engine-debug-",
      ["transcribe"],
      [
        `  printf '%s\\n' '{"kind":"debug","t_ms":7,"event":"asr.backend_loaded","message":"asr::backend_loaded dt=12ms","fields":{"dt_ms":12}}' >&2`,
        `  printf '%s\\n' '{"text":"ok","segments":[{"start":0,"end":1,"text":"ok"}]}'`,
      ].join("\n"),
    );
    const audio = join(dir, "note.ogg");
    writeFileSync(audio, "OggS");
    const env = {
      HOME: dir,
      KESHA_HOME: home,
      KESHA_CACHE_DIR: join(dir, "cache"),
      KESHA_LOG_DIR: join(home, "logs"),
      KESHA_ENGINE_BIN: enginePath,
    };

    expect((await runCliScenario(["logs", "mode", "on"], { env })).exitCode).toBe(0);
    const run = await runCliScenario([audio], { env });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("ok");

    const raw = readFileSync(join(home, "logs", "kesha.ndjson"), "utf8");
    const events = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.find((event) => event.event === "engine.debug")).toMatchObject({
      t_ms: 7,
      engineEvent: "asr.backend_loaded",
      dt_ms: 12,
    });
    expect(raw).not.toContain("asr::backend_loaded dt=12ms");
  }, 30_000);
});
