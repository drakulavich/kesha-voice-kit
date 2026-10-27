import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir";

const SOURCE = join(import.meta.dir, "..", "..", "rust", "swift", "say-avspeech.swift");
const VOICE = "com.apple.voice.compact.en-US.Samantha";
// Long enough that Samantha emits a zero-length buffer mid-utterance (#1386).
const TEXT =
  "One two three four five six seven eight nine ten. Eleven twelve thirteen fourteen fifteen. " +
  "Sixteen seventeen eighteen nineteen twenty. Twenty one twenty two twenty three twenty four. " +
  "Twenty five twenty six twenty seven twenty eight. Twenty nine thirty thirty one thirty two. " +
  "Thirty three thirty four.";

function wavSeconds(bytes: Buffer): number {
  let byteRate = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "fmt ") byteRate = bytes.readUInt32LE(at + 16);
    if (id === "data") return size / byteRate;
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}

// A cold swiftc module cache alone took 33 s locally and used up the old 60 s test timeout on CI (#1560).
const COMPILE_MS = 150_000;
const SPEAK_MS = 30_000;

function run(argv: string[], timeoutMs: number, stdin?: string): Buffer {
  const proc = Bun.spawnSync(argv, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), timeout: timeoutMs });
  if (proc.exitCode !== 0)
    throw new Error(
      `${argv[0]} ${proc.signalCode ? `was killed (${proc.signalCode}) after its ${timeoutMs} ms budget` : `exited ${proc.exitCode}`}: ${proc.stderr.toString()}`,
    );
  return proc.stdout;
}

const darwinTest = process.platform === "darwin" ? test : test.skip;

describe("say-avspeech sidecar", () => {
  darwinTest(
    "speaks a long text as long as say(1) does, tail included",
    () => {
      const dir = tempDir("kesha-avspeech-");
      const bin = join(dir, "say-avspeech");
      run(["swiftc", "-o", bin, SOURCE], COMPILE_MS);
      const sidecarWav = join(dir, "sidecar.wav");
      writeFileSync(sidecarWav, run([bin, VOICE], SPEAK_MS, TEXT));
      const sayWav = join(dir, "say.wav");
      run(["say", "-v", VOICE, "--data-format=LEI16", "-o", sayWav, TEXT], SPEAK_MS);

      const sidecar = wavSeconds(readFileSync(sidecarWav));
      const reference = wavSeconds(readFileSync(sayWav));
      expect(reference).toBeGreaterThan(15);
      expect(Math.abs(sidecar - reference)).toBeLessThan(0.25);
    },
    COMPILE_MS + 2 * SPEAK_MS,
  );
});
