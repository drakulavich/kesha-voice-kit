#!/usr/bin/env bun
/**
 * Asserts `kesha --json <audio>` produced exactly one result with usable text.
 *
 * Usage: bun .github/scripts/assert-transcript.ts <json-file> <expected-word>
 */
export function assertSingleTranscript(raw: string, label: string, expected?: string): string {
  let results: Array<{ text?: string }>;
  try {
    results = JSON.parse(raw);
  } catch {
    throw new Error(`${label}: expected JSON on stdout, got ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error(
      `${label}: expected exactly one transcription result, got ${JSON.stringify(results).slice(0, 200)}`,
    );
  }
  const text = results[0]?.text?.trim() ?? "";
  if (text.length < 5) {
    throw new Error(`${label}: expected non-empty transcription text, got ${JSON.stringify(text)}`);
  }
  if (expected !== undefined && !text.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(
      `${label}: expected the transcript to contain ${JSON.stringify(expected)}, got ${JSON.stringify(text)}`,
    );
  }
  return text;
}

if (import.meta.main) {
  const [path, expected] = process.argv.slice(2);
  if (!path || !expected) {
    console.error("usage: assert-transcript.ts <json-file> <expected-word>");
    process.exit(2);
  }
  try {
    const text = assertSingleTranscript(await Bun.file(path).text(), path, expected);
    console.log(`ok: transcribed "${text.slice(0, 60)}"`);
  } catch (e) {
    console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
