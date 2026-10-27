/** Consumer side of the protocol-events pact (#1478); `rust/tests/protocol_events_pact.rs` records the fixture. */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseEventLine } from "../../src/engine/events";
import { readRepoFile, REPO_ROOT } from "../helpers/repo";

const FIXTURE = "tests/fixtures/protocol-events.ndjson";

const recorded = readRepoFile(FIXTURE)
  .split(/\r?\n/)
  .filter((line) => line.length > 0)
  .map((line) => ({ line, value: JSON.parse(line) as Record<string, unknown> }));

const recordedKeys = new Map(recorded.map(({ value }) => [value.kind as string, new Set(Object.keys(value))]));

/** Every `{"kind":…}` object literal in tests/, plain or with `\"` escapes, cut at its balanced closing brace. */
function eventLiterals(source: string): string[] {
  const found: string[] = [];
  for (const start of ['{"kind":', '{\\"kind\\":']) {
    let at = source.indexOf(start);
    while (at !== -1) {
      let depth = 0;
      for (let i = at; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) {
          found.push(source.slice(at, i + 1).replaceAll('\\"', '"'));
          break;
        }
      }
      at = source.indexOf(start, at + 1);
    }
  }
  return found;
}

function testSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : testSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("protocol-events pact — the parser", () => {
  it("records one event of every kind the parser accepts", () => {
    expect(recorded.map(({ value }) => value.kind)).toEqual(["progress", "warn", "error", "debug"]);
  });

  it("forwards every recorded field with its value", () => {
    for (const { line, value } of recorded) {
      expect(parseEventLine(line), line).toEqual({ ok: true, event: value as never });
    }
  });
});

describe("protocol-events pact — the fakes in tests/", () => {
  const checked = testSources(join(REPO_ROOT, "tests")).flatMap((path) =>
    eventLiterals(readFileSync(path, "utf8")).flatMap((literal) => {
      // Templated or deliberately malformed lines are the parser's negative cases, not fakes of a real event.
      try {
        JSON.parse(literal);
      } catch {
        return [];
      }
      const parsed = parseEventLine(literal);
      return parsed.ok ? [{ file: relative(REPO_ROOT, path), literal, kind: parsed.event.kind }] : [];
    }),
  );

  it("finds fake lines of every kind", () => {
    expect(new Set<string>(checked.map((c) => c.kind))).toEqual(new Set(recordedKeys.keys()));
  });

  it("use only fields the engine emits for that kind", () => {
    const strays = checked.flatMap(({ file, literal, kind }) =>
      Object.keys(JSON.parse(literal))
        .filter((key) => !recordedKeys.get(kind)?.has(key))
        .map((key) => `${file}: "${key}" in ${literal}`),
    );
    expect(strays).toEqual([]);
  });
});
