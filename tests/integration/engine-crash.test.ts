import { describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { writeTranscribingEngine } from "../helpers/fake-engine";
import { tempDir } from "../helpers/temp-dir";
import { runCliScenario } from "./cli-scenario";

const scenarioTest = process.platform === "win32" ? test.skip : test;

describe("a transcription engine killed by a signal (#1500)", () => {
  scenarioTest("names the signal and the next step, and keeps exit 1", async () => {
    const dir = tempDir("kesha-engine-crash-");
    const enginePath = writeTranscribingEngine("kesha-engine-segv-", ["transcribe"], "  kill -SEGV $$");
    const audio = join(dir, "note.ogg");
    writeFileSync(audio, "OggS");

    const run = await runCliScenario([audio], {
      env: { HOME: dir, KESHA_HOME: join(dir, "state"), KESHA_CACHE_DIR: join(dir, "cache"), KESHA_ENGINE_BIN: enginePath },
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("error [E_INTERNAL]: kesha-engine transcribe was killed by SIGSEGV");
    expect(run.stderr).toContain("hint: re-run with KESHA_DEBUG=1");
    expect(run.stderr).toContain("kesha support-bundle");
    expect(run.stderr).not.toContain("exited with code 139");
  });
});
