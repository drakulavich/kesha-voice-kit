#!/usr/bin/env bun
/**
 * Round-trip smoke for a shipped engine: synthesise with both TTS engines, then
 * transcribe the result back. Closes the last #216 acceptance criterion, which
 * no lane covered — rust-test.yml runs unit and contract tests, and the Linux
 * engine smokes transcribe a fixture but never synthesise.
 *
 * Usage: bun .github/scripts/smoke-synthesis.ts <work-dir>
 */
import { mkdirSync } from "fs";
import { join } from "path";

const workDir = process.argv[2];
if (!workDir) {
  console.error("usage: smoke-synthesis.ts <work-dir>");
  process.exit(2);
}
mkdirSync(workDir, { recursive: true });

const VOICES = [
  { voice: "en-am_michael", text: "The quick brown fox jumps over the lazy dog." },
  { voice: "ru-vosk-m02", text: "Проверка синтеза речи на русском языке." },
];

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["kesha", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, code: await proc.exited };
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

for (const { voice, text } of VOICES) {
  const outPath = join(workDir, `${voice}.wav`);
  const say = await run(["say", text, "--voice", voice, "--out", outPath]);
  if (say.code !== 0) fail(`\`kesha say --voice ${voice}\` exited ${say.code}\n${say.stderr}`);

  const wav = Bun.file(outPath);
  if (!(await wav.exists())) fail(`${voice}: --out produced no file at ${outPath}`);

  const bytes = new Uint8Array(await wav.arrayBuffer());
  // A header-only WAV is 44 bytes; anything at or below that synthesised silence.
  if (bytes.length <= 44) fail(`${voice}: WAV is ${bytes.length} bytes, i.e. header without audio`);

  const riff = new TextDecoder().decode(bytes.subarray(0, 4));
  const wave = new TextDecoder().decode(bytes.subarray(8, 12));
  if (riff !== "RIFF" || wave !== "WAVE") {
    fail(`${voice}: expected a RIFF/WAVE header, got "${riff}"/"${wave}"`);
  }
  console.log(`ok: ${voice} synthesised ${bytes.length} bytes`);

  const back = await run(["--json", outPath]);
  if (back.code !== 0) fail(`transcribing ${voice}.wav exited ${back.code}\n${back.stderr}`);

  let results: Array<{ text?: string }>;
  try {
    results = JSON.parse(back.stdout);
  } catch (e) {
    fail(`transcribing ${voice}.wav returned non-JSON stdout: ${back.stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(results) || results.length !== 1) {
    fail(`transcribing ${voice}.wav: expected exactly one result, got ${JSON.stringify(results).slice(0, 200)}`);
  }
  // Not asserting on WER: this proves the engine speaks and hears, not that it
  // is accurate. Accuracy has its own benchmark lane.
  const transcript = results[0]?.text?.trim() ?? "";
  if (transcript.length < 5) {
    fail(`transcribing ${voice}.wav produced no usable text (got ${JSON.stringify(transcript)})`);
  }
  console.log(`ok: ${voice} round-tripped to "${transcript.slice(0, 60)}"`);
}

console.log("Synthesis round-trip smoke passed.");
