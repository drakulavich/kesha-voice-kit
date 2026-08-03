#!/usr/bin/env bun
/**
 * Round-trip smoke for a shipped engine: synthesise with both TTS engines, then
 * transcribe the result back. Closes the last #216 acceptance criterion, which
 * no lane covered — rust-test.yml runs unit and contract tests, and the Linux
 * engine smokes transcribe a fixture but never synthesise.
 *
 * Usage: bun .github/scripts/smoke-synthesis.ts [--no-roundtrip] [--voice <id>] <work-dir>
 *
 * `--no-roundtrip` stops after synthesis and drops to English only. It exists for
 * build-engine.yml's pre-upload gate (#671), which runs on a release builder with no ASR
 * model set — transcribing back there would cost a multi-GB download per platform.
 * `--voice` overrides the voice, for platforms whose default engine can't run in CI.
 */
import { mkdirSync } from "fs";
import { join } from "path";
import { assertSingleTranscript } from "./assert-transcript";

const ENGLISH = "The quick brown fox jumps over the lazy dog.";
const ALL_VOICES = [
  { voice: "en-am_michael", text: ENGLISH },
  { voice: "ru-vosk-m02", text: "Проверка синтеза речи на русском языке." },
];

export type SmokeArgs = { workDir: string; noRoundtrip: boolean; voices: typeof ALL_VOICES };

/** Returns null when argv is unusable; the caller prints usage and exits 2. */
export function parseArgs(argv: string[]): SmokeArgs | null {
  const noRoundtrip = argv.includes("--no-roundtrip");
  const voiceFlag = argv.indexOf("--voice");
  const voiceOverride = voiceFlag === -1 ? undefined : argv[voiceFlag + 1];
  if (voiceFlag !== -1 && (!voiceOverride || voiceOverride.startsWith("--"))) return null;

  const voiceValueAt = voiceFlag === -1 ? -1 : voiceFlag + 1;
  const workDir = argv.find((arg, i) => !arg.startsWith("--") && i !== voiceValueAt);
  if (!workDir) return null;

  const voices = voiceOverride
    ? [{ voice: voiceOverride, text: ENGLISH }]
    : noRoundtrip
      ? ALL_VOICES.filter((v) => v.voice === "en-am_michael")
      : ALL_VOICES;
  return { workDir, noRoundtrip, voices };
}


// Without a timeout a hung `kesha say` burns the whole job budget and reports nothing useful.
async function run(
  args: string[],
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["kesha", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, code: await proc.exited };
  } finally {
    clearTimeout(timer);
  }
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: smoke-synthesis.ts [--no-roundtrip] [--voice <id>] <work-dir>");
    process.exit(2);
  }
  const { workDir, noRoundtrip, voices } = parsed;
  mkdirSync(workDir, { recursive: true });

  for (const { voice, text } of voices) {
    const outPath = join(workDir, `${voice}.wav`);
    const say = await run(["say", text, "--voice", voice, "--out", outPath]);
    if (say.code !== 0) fail(`\`kesha say --voice ${voice}\` exited ${say.code}\n${say.stderr}`);

    const wav = Bun.file(outPath);
    if (!(await wav.exists())) fail(`${voice}: --out produced no file at ${outPath}`);

    const bytes = new Uint8Array(await wav.arrayBuffer());
    // A header-only WAV is 44 bytes; anything at or below that synthesised silence.
    if (bytes.length <= 44) fail(`${voice}: WAV is ${bytes.length} bytes, i.e. header without audio`);

    const header = new TextDecoder().decode(bytes.subarray(0, 12));
    if (!header.startsWith("RIFF") || header.slice(8) !== "WAVE") {
      fail(`${voice}: expected a RIFF/WAVE header, got ${JSON.stringify(header)}`);
    }
    console.log(`ok: ${voice} synthesised ${bytes.length} bytes`);
    if (noRoundtrip) continue;

    const back = await run(["--json", outPath]);
    if (back.code !== 0) fail(`transcribing ${voice}.wav exited ${back.code}\n${back.stderr}`);

    // Not asserting on WER: this proves the engine speaks and hears, not that it is accurate.
    let transcript: string;
    try {
      transcript = assertSingleTranscript(back.stdout, `${voice}.wav`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    console.log(`ok: ${voice} round-tripped to "${transcript.slice(0, 60)}"`);
  }

  console.log(noRoundtrip ? "Synthesis smoke passed." : "Synthesis round-trip smoke passed.");
}
