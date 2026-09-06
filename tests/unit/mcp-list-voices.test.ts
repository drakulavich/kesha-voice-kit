import { describe, test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { listVoices } from "../../src/mcp/voices";
import { errorMessage } from "../../src/error-utils";
import { describeJson } from "../helpers/fake-engine";
import { KeshaError } from "../../src/engine/events";

const skipOnWin32 = process.platform === "win32" ? test.skip : test;

async function withEngineBin<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prevBin = process.env.KESHA_ENGINE_BIN;
  process.env.KESHA_ENGINE_BIN = bin;
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.KESHA_ENGINE_BIN;
    else process.env.KESHA_ENGINE_BIN = prevBin;
  }
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const server = createKeshaMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(c);
  return client.callTool({ name, arguments: args });
}

async function withMissingEngine<T>(fn: () => Promise<T>): Promise<T> {
  const prevBin = process.env.KESHA_ENGINE_BIN;
  const prevCache = process.env.KESHA_CACHE_DIR;
  delete process.env.KESHA_ENGINE_BIN;
  process.env.KESHA_CACHE_DIR = `/tmp/kesha-mcp-empty-${Date.now()}-${Math.random()}`;
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.KESHA_ENGINE_BIN;
    else process.env.KESHA_ENGINE_BIN = prevBin;
    if (prevCache === undefined) delete process.env.KESHA_CACHE_DIR;
    else process.env.KESHA_CACHE_DIR = prevCache;
  }
}

describe("list_voices / list_languages guard when the engine is missing", () => {
  test("listVoices() throws an install-hint error, not a raw spawn exception", async () => {
    await withMissingEngine(async () => {
      await expect(listVoices()).rejects.toThrow(/kesha-engine not installed. run: (kesha install|kesha init)$/);
    });
  });

  test("list_voices tool returns isError with the install hint", async () => {
    await withMissingEngine(async () => {
      const res = await call("list_voices");
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0]?.text).toContain("kesha-engine not installed");
    });
  });

  test("list_languages tool returns isError with the install hint", async () => {
    await withMissingEngine(async () => {
      const res = await call("list_languages");
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0]?.text).toContain("kesha-engine not installed");
    });
  });
});

describe("list_voices guard when the engine is present but not executable", () => {
  skipOnWin32("list_voices tool returns isError with E_ENGINE_SPAWN, not a raw spawn exception", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-mcp-not-exec-"));
    const notExecutable = join(dir, "kesha-engine");
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);

    await withEngineBin(notExecutable, async () => {
      const res = await call("list_voices");
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("E_ENGINE_SPAWN");
      expect(text).toContain(notExecutable);
    });
  });
});

// A stub, because gating on an installed engine skipped these in every CI lane (#984).
function voiceListingEngine(voiceIds: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kesha-mcp-voices-"));
  const path = join(dir, "kesha-engine");
  const args = voiceIds.map((id) => `'${id}'`).join(" ");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: ["tts"] })}'\n  exit 0\nfi\nif [ "$1" = "say" ] && [ "$2" = "--list-voices" ]; then\n  printf '%s\\n' ${args}\n  exit 0\nfi\nexit 2\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const STUB_VOICES = ["en-am_michael", "en-bf_emma", "ru-vosk-m02"];

// A stub that answers on stdout but writes plain prose to stderr instead of a protocol 4 event.
function babblingVoicesEngine(): string {
  const dir = mkdtempSync(join(tmpdir(), "kesha-mcp-voices-babble-"));
  const path = join(dir, "kesha-engine");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: ["tts"] })}'\n  exit 0\nfi\nif [ "$1" = "say" ] && [ "$2" = "--list-voices" ]; then\n  printf '%s\\n' 'en-am_michael'\n  echo "loading voice pack..." >&2\n  exit 0\nfi\nexit 2\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("list_voices() surfaces a non-event stderr line even on a clean exit", () => {
  skipOnWin32("rejects with E_INTERNAL quoting the offending line", async () => {
    await withEngineBin(babblingVoicesEngine(), async () => {
      await expect(listVoices()).rejects.toThrow('kesha-engine say --list-voices wrote a line that is not a protocol event: "loading voice pack..."');
      try {
        await listVoices();
        throw new Error("expected listVoices() to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe("E_INTERNAL");
        expect(errorMessage(err)).toMatch(/^error \[E_INTERNAL\]: kesha-engine say --list-voices wrote a line that is not a protocol event: "loading voice pack\.\.\."/);
      }
    });
  });
});

describe("list_voices tool", () => {
  skipOnWin32("returns structured voices with new schema", async () => {
    await withEngineBin(voiceListingEngine(STUB_VOICES), async () => {
      const res = await call("list_voices");
      expect(res.isError).toBeUndefined();
      const sc = res.structuredContent as {
        voices: Array<{ voiceId: string; modelId: string; modelName: string; languageCode: string; languageName: string; gender: string | null }>;
      };
      // The English default is a brand contract; naming it pins every field, BCP-47 tag included.
      expect(sc.voices.find((v) => v.voiceId === "en-am_michael")).toEqual({
        voiceId: "en-am_michael",
        modelId: "kokoro",
        modelName: "Kokoro-82M",
        languageCode: "en-US",
        languageName: "American English",
        gender: "male",
      });
      expect(sc.voices.map((v) => v.voiceId)).toEqual(STUB_VOICES);
    });
  });
});

describe("list_languages tool", () => {
  skipOnWin32("returns structured languages", async () => {
    await withEngineBin(voiceListingEngine(STUB_VOICES), async () => {
      const res = await call("list_languages");
      expect(res.isError).toBeUndefined();
      const sc = res.structuredContent as {
        languages: Array<{ languageCode: string; languageName: string; voiceCount: number }>;
      };
      expect(sc.languages).toEqual([
        { languageCode: "en-GB", languageName: "British English", voiceCount: 1 },
        { languageCode: "en-US", languageName: "American English", voiceCount: 1 },
        { languageCode: "ru", languageName: "Russian", voiceCount: 1 },
      ]);
    });
  });
});

describe("list_voices() validates against describe before spawning", () => {
  skipOnWin32("a stale engine that cannot describe itself is E_ENGINE_PROTOCOL pointing at kesha install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-mcp-voices-stale-"));
    const path = join(dir, "kesha-engine");
    writeFileSync(
      path,
      `#!/bin/sh\nif [ "$1" = "say" ]; then\n  printf '%s\\n' 'en-am_michael'\n  echo "Model mirror active: https://example" >&2\n  exit 0\nfi\necho "error: unrecognized subcommand describe" >&2\nexit 2\n`,
    );
    chmodSync(path, 0o755);
    await withEngineBin(path, async () => {
      const err = await listVoices().then(() => null, (e: unknown) => e as KeshaError);
      expect(err).toBeInstanceOf(KeshaError);
      expect(err!.code).toBe("E_ENGINE_PROTOCOL");
      expect(errorMessage(err)).toContain("hint: run `kesha install`");
    });
  });

  skipOnWin32("a build without tts is E_INVALID_ARG and the engine is never asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-mcp-voices-notts-"));
    const path = join(dir, "kesha-engine");
    const marker = join(dir, "say-was-spawned");
    writeFileSync(
      path,
      `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: ["transcribe"] })}'\n  exit 0\nfi\ntouch '${marker}'\nexit 2\n`,
    );
    chmodSync(path, 0o755);
    await withEngineBin(path, async () => {
      const err = await listVoices().then(() => null, (e: unknown) => e as KeshaError);
      expect(err).toBeInstanceOf(KeshaError);
      expect(err!.code).toBe("E_INVALID_ARG");
      expect(existsSync(marker)).toBe(false);
    });
  });
});

// A stub whose describe answers normally but whose `say --list-voices` reports a coded failure.
function voiceListingErrorEngine(): string {
  const dir = mkdtempSync(join(tmpdir(), "kesha-mcp-voices-error-"));
  const path = join(dir, "kesha-engine");
  const errorEvent = JSON.stringify({
    kind: "error",
    code: "E_MODEL_MISSING",
    message: "the TTS bundle is missing",
    hint: "run kesha install --tts",
  });
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: ["tts"] })}'\n  exit 0\nfi\nif [ "$1" = "say" ] && [ "$2" = "--list-voices" ]; then\n  printf '%s\\n' '${errorEvent}' >&2\n  exit 1\nfi\nexit 2\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("list_voices / list_languages surface an engine-reported failure coded", () => {
  skipOnWin32("list_voices tool returns isError carrying the engine's code and hint", async () => {
    await withEngineBin(voiceListingErrorEngine(), async () => {
      const res = await call("list_voices");
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("error [E_MODEL_MISSING]:");
      expect(text).toContain("hint: run kesha install --tts");
    });
  });

  skipOnWin32("list_languages tool returns isError carrying the engine's code and hint", async () => {
    await withEngineBin(voiceListingErrorEngine(), async () => {
      const res = await call("list_languages");
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("error [E_MODEL_MISSING]:");
      expect(text).toContain("hint: run kesha install --tts");
    });
  });
});
