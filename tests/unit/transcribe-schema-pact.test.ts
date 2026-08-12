/**
 * Consumer side of the transcribe schema pact (#917).
 *
 * `rust/tests/transcribe_schema_pact.rs` records everything the engine's
 * transcribe JSON can carry into `tests/fixtures/transcribe-schema.json`; this
 * drives that recording through the seams every consumer reads it by — the
 * parser behind `transcribeWithSegments`, the CLI's `--json`, and `--toon`.
 * A field the Rust side gains and the TS side drops is red here, which is what
 * `words` (#905) and `speaker` (#199) each needed and neither had.
 */
import { decode as decodeToon } from "@toon-format/toon";
import { describe, expect, it } from "bun:test";
import { formatJsonOutput, formatToonOutput } from "../../src/cli";
import { parseTranscriptionOutput } from "../../src/engine";
import { readRepoFile } from "../helpers/repo";

const FIXTURE = "tests/fixtures/transcribe-schema.json";

/**
 * Paths the parser drops on purpose, in `fieldPaths` notation
 * (`segments[].speaker`), each with its reason. Empty means the seam forwards
 * everything the engine emits; an entry here is the reviewed alternative to a
 * field silently going missing, so it must say why the user does not need it.
 */
const EXCLUDED_FIELDS: Record<string, string> = {};

/** Every field path in `value`, with array indices collapsed to `[]`. */
function fieldPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => fieldPaths(item, `${prefix}[]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...fieldPaths(child, path)];
  });
}

function withoutExcluded(value: unknown, prefix = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutExcluded(item, `${prefix}[]`));
  if (value === null || typeof value !== "object") return value;
  const kept: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path in EXCLUDED_FIELDS) continue;
    kept[key] = withoutExcluded(child, path);
  }
  return kept;
}

const raw = readRepoFile(FIXTURE);
const recorded = JSON.parse(raw);
const parsed = parseTranscriptionOutput(raw);
const recordedPaths = new Set(fieldPaths(recorded));

describe("transcribe schema pact — the parser", () => {
  it("forwards every field the engine records", () => {
    const parsedPaths = new Set(fieldPaths(parsed));
    const dropped = [...recordedPaths].filter(
      (path) => !parsedPaths.has(path) && !(path in EXCLUDED_FIELDS),
    );
    expect(
      dropped,
      `parseTranscriptionOutput drops ${dropped.join(", ")} — forward it, or name it in EXCLUDED_FIELDS with a reason`,
    ).toEqual([]);
  });

  it("copies the recorded values, not just the keys", () => {
    expect(parsed).toEqual(withoutExcluded(recorded) as typeof parsed);
  });

  it("excludes only fields the recording still carries", () => {
    // A stale exclusion is a hole: the path it names could come back forwarding nothing.
    expect(Object.keys(EXCLUDED_FIELDS).filter((path) => !recordedPaths.has(path))).toEqual([]);
  });
});

describe("transcribe schema pact — the output encoders", () => {
  const results = [{ file: "a.ogg", lang: "en", text: parsed.text, segments: parsed.segments }];

  it("round-trips the parsed output through --toon", () => {
    expect(decodeToon(formatToonOutput(results)) as unknown).toEqual(results);
  });

  it("round-trips the parsed output through --json", () => {
    expect(JSON.parse(formatJsonOutput(results))).toEqual(results);
  });
});
