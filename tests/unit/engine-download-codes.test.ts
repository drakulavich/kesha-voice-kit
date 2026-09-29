import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "path";
import { existsSync, readdirSync, writeFileSync } from "fs";
import { install, KeshaError } from "../../src/lib";
import { getEngineBinPath } from "../../src/engine";
import { engineChecksums, installEngine } from "../../src/engine-install";
import { expectServedBody, isolateEngineCache } from "../helpers/fake-engine";
import { failEngineStagingWrites } from "../helpers/failing-writes";
import { tempDir } from "../helpers/temp-dir";

const ENGINE = "#!/bin/sh\nexit 0\n";
const savedFetch = globalThis.fetch;
let restore: () => void = () => {};

const BROKEN_MID_STREAM = `(() => { let sent = false; return new ReadableStream({ pull(c) { if (sent) { c.error(new TypeError("The socket connection was closed unexpectedly")); return; } sent = true; c.enqueue(new TextEncoder().encode(${JSON.stringify(ENGINE.slice(0, 5))})); } }); })()`;
const ZERO_BYTES = `new ReadableStream({ start(c) { c.close(); } })`;
const streamed = (body: string) => (0, eval)(`(async () => new Response(${body}, { status: 200 }))`) as typeof fetch;

type Failure = { name: string; fetch: typeof fetch; served: string; code: string; hint: RegExp };

const FAILURES: Failure[] = [
  {
    name: "a network error",
    fetch: (async () => {
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof fetch,
    served: ENGINE,
    code: "E_MODEL_DOWNLOAD",
    hint: /network connection/,
  },
  {
    name: "an HTTP 404",
    fetch: (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch,
    served: ENGINE,
    code: "E_MODEL_DOWNLOAD",
    hint: /releases/,
  },
  {
    name: "an empty response body",
    fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    served: ENGINE,
    code: "E_MODEL_DOWNLOAD",
    hint: /try again/i,
  },
  {
    name: "a body stream that breaks mid-download",
    fetch: streamed(BROKEN_MID_STREAM),
    served: ENGINE,
    code: "E_MODEL_DOWNLOAD",
    hint: /network connection/,
  },
  {
    name: "a body stream that yields zero bytes",
    fetch: streamed(ZERO_BYTES),
    served: ENGINE,
    code: "E_MODEL_DOWNLOAD",
    hint: /try again/i,
  },
  {
    name: "a SHA-256 mismatch",
    fetch: (async () => new Response(ENGINE, { status: 200 })) as unknown as typeof fetch,
    served: "the bytes the release published",
    code: "E_CACHE_CORRUPT",
    hint: /re-run `kesha install`/,
  },
];

beforeEach(() => {
  restore = isolateEngineCache();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  restore();
});

function expectNoEngineLeftBehind(): void {
  const binPath = getEngineBinPath();
  expect(existsSync(binPath)).toBe(false);
  const dir = dirname(binPath);
  const staged = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("kesha-engine.part.")) : [];
  expect(staged).toEqual([]);
}

async function rejectionOf(p: Promise<unknown>): Promise<KeshaError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(KeshaError);
  return err as KeshaError;
}

describe("an engine download failure carries a code and a hint", () => {
  for (const f of FAILURES) {
    test(`installEngine: ${f.name} is ${f.code}`, async () => {
      expectServedBody(() => f.served);
      globalThis.fetch = f.fetch;

      const err = await rejectionOf(installEngine());

      expect(err.code).toBe(f.code);
      expect(err.hint).toMatch(f.hint);
      expectNoEngineLeftBehind();
    }, 30_000);

    test(`Core API install(): ${f.name} rejects as ${f.code}, not E_INTERNAL`, async () => {
      expectServedBody(() => f.served);
      globalThis.fetch = f.fetch;

      const err = await rejectionOf(install());

      expect(err.code).toBe(f.code);
      expect(err.hint).toMatch(f.hint);
      expectNoEngineLeftBehind();
    }, 30_000);
  }
});

const CLI_CASES = [
  { name: "a body stream that breaks mid-download", fetch: `async () => new Response(${BROKEN_MID_STREAM}, { status: 200 })`, served: ENGINE, code: "E_MODEL_DOWNLOAD", hint: "network connection" },
  { name: "a body stream that yields zero bytes", fetch: `async () => new Response(${ZERO_BYTES}, { status: 200 })`, served: ENGINE, code: "E_MODEL_DOWNLOAD", hint: "try again" },
  { name: "an HTTP 404", fetch: `async () => new Response("Not Found", { status: 404 })`, served: ENGINE, code: "E_MODEL_DOWNLOAD", hint: "releases" },
  { name: "a SHA-256 mismatch", fetch: `async () => new Response(${JSON.stringify(ENGINE)}, { status: 200 })`, served: "the bytes the release published", code: "E_CACHE_CORRUPT", hint: "re-run `kesha install`" },
];

describe("kesha install reports an engine download failure by its code", () => {
  for (const c of CLI_CASES) {
    test(`${c.name}: error [${c.code}] with a hint, exit 1`, async () => {
      const dir = tempDir("kesha-download-code-cli-");
      const script = join(dir, "install.ts");
      const src = (p: string) => JSON.stringify(join(import.meta.dir, "../../src", p));
      writeFileSync(
        script,
        `import { createHash } from "crypto";\n` +
          `import { performInstall } from ${src("cli/install.ts")};\n` +
          `import { engineChecksums } from ${src("engine-install.ts")};\n` +
          `const sha256 = createHash("sha256").update(${JSON.stringify(c.served)}).digest("hex");\n` +
          `engineChecksums.forRelease = () => async () => ({ sha256, source: "the test's pin" });\n` +
          `globalThis.fetch = (${c.fetch}) as typeof fetch;\n` +
          `await performInstall({ noCache: false, ttsLangs: [] });\n`,
      );
      const proc = Bun.spawn([process.execPath, script], {
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", KESHA_ENGINE_BIN: join(dir, "bin", "kesha-engine") },
        stdout: "ignore",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(stderr).toContain(`error [${c.code}]: `);
      expect(stderr).toMatch(/\n\s+hint: /);
      expect(stderr.slice(stderr.indexOf("hint: "))).toContain(c.hint);
      expect(exitCode).toBe(1);
      expect(existsSync(join(dir, "bin", "kesha-engine"))).toBe(false);
    }, 30_000);
  }
});

const SUMS_HINT = ["--engine-version", "https://github.com/drakulavich/kesha-voice-kit/releases"];
const SUMS_CASES = [
  { name: "HTTP 503", respond: `new Response("Service Unavailable", { status: 503 })`, hint: SUMS_HINT },
  { name: "HTTP 404", respond: `new Response("Not Found", { status: 404 })`, hint: SUMS_HINT },
  { name: "HTTP 200 with an empty body", respond: `new Response("", { status: 200 })`, hint: SUMS_HINT },
  { name: "a body that breaks while it is read", respond: `new Response(${BROKEN_MID_STREAM}, { status: 200 })`, hint: ["network connection"] },
];

function sumsFetch(respond: string): string {
  return `async (input) => String(input instanceof Request ? input.url : input).endsWith("/SHA256SUMS") ? ${respond} : new Response(${JSON.stringify(ENGINE)}, { status: 200 })`;
}

describe("a SHA256SUMS the installer cannot use is E_MODEL_DOWNLOAD with a hint", () => {
  for (const c of SUMS_CASES) {
    for (const [surface, run] of [
      ["installEngine", () => installEngine()],
      ["Core API install()", () => install()],
    ] as const) {
      test(`${surface}: SHA256SUMS ${c.name}`, async () => {
        engineChecksums.pins = undefined;
        globalThis.fetch = (0, eval)(`(${sumsFetch(c.respond)})`) as typeof fetch;

        const err = await rejectionOf(run());

        expect(err.code).toBe("E_MODEL_DOWNLOAD");
        for (const part of c.hint) expect(err.hint).toContain(part);
      }, 30_000);
    }

    test(`kesha install: SHA256SUMS ${c.name} is error [E_MODEL_DOWNLOAD] with a hint, exit 1`, async () => {
      const dir = tempDir("kesha-download-code-sums-");
      const script = join(dir, "install.ts");
      const src = (p: string) => JSON.stringify(join(import.meta.dir, "../../src", p));
      writeFileSync(
        script,
        `import { performInstall } from ${src("cli/install.ts")};\n` +
          `import { engineChecksums } from ${src("engine-install.ts")};\n` +
          `engineChecksums.pins = undefined;\n` +
          `globalThis.fetch = (${sumsFetch(c.respond)}) as typeof fetch;\n` +
          `await performInstall({ noCache: false, ttsLangs: [] });\n`,
      );
      const proc = Bun.spawn([process.execPath, script], {
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", KESHA_ENGINE_BIN: join(dir, "bin", "kesha-engine") },
        stdout: "ignore",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(stderr).toMatch(/^error \[E_MODEL_DOWNLOAD\]: /m);
      for (const part of c.hint) expect(stderr.slice(stderr.indexOf("hint: "))).toContain(part);
      expect(exitCode).toBe(1);
    }, 30_000);
  }
});

const WRITE_FAILURES = [
  { errno: "ENOSPC", code: "E_INTERNAL", exit: 4, why: /no space left/i, hint: /the disk is full: free space/ },
  { errno: "EIO", code: "E_INTERNAL", exit: 4, why: /input\/output error/i, hint: /resolve that filesystem error/ },
  { errno: "EACCES", code: "E_INVALID_ARG", exit: 2, why: /permission denied/i, hint: /KESHA_ENGINE_BIN|KESHA_CACHE_DIR/ },
  { errno: "EROFS", code: "E_INVALID_ARG", exit: 2, why: /read-only/i, hint: /KESHA_ENGINE_BIN|KESHA_CACHE_DIR/ },
] as const;

describe("a disk failure while the engine is written is not reported as a download failure", () => {
  let restoreWrites: () => void = () => {};
  afterEach(() => restoreWrites());

  for (const w of WRITE_FAILURES) {
    for (const [surface, run] of [
      ["installEngine", () => installEngine()],
      ["Core API install()", () => install()],
    ] as const) {
      test(`${surface}: ${w.errno} writing the engine is ${w.code}, naming the path`, async () => {
        expectServedBody(() => ENGINE);
        globalThis.fetch = (async () => new Response(ENGINE, { status: 200 })) as unknown as typeof fetch;
        restoreWrites = failEngineStagingWrites(w.errno);

        const err = await rejectionOf(run());

        expect(err.code).toBe(w.code);
        expect(err.message).toMatch(w.why);
        expect(`${err.message}\n${err.hint ?? ""}`).toContain(dirname(getEngineBinPath()));
        expect(`${err.message}\n${err.hint ?? ""}`).toMatch(w.hint);
        expectNoEngineLeftBehind();
      }, 30_000);
    }

    test(`kesha install: ${w.errno} writing the engine is error [${w.code}], exit ${w.exit}`, async () => {
      const dir = tempDir("kesha-download-code-write-");
      const script = join(dir, "install.ts");
      const src = (p: string) => JSON.stringify(join(import.meta.dir, "../../src", p));
      writeFileSync(
        script,
        `import { createHash } from "crypto";\n` +
          `import { performInstall } from ${src("cli/install.ts")};\n` +
          `import { engineChecksums } from ${src("engine-install.ts")};\n` +
          `import { failEngineStagingWrites } from ${JSON.stringify(join(import.meta.dir, "../helpers/failing-writes.ts"))};\n` +
          `const sha256 = createHash("sha256").update(${JSON.stringify(ENGINE)}).digest("hex");\n` +
          `engineChecksums.forRelease = () => async () => ({ sha256, source: "the test's pin" });\n` +
          `globalThis.fetch = (async () => new Response(${JSON.stringify(ENGINE)}, { status: 200 })) as typeof fetch;\n` +
          `failEngineStagingWrites(${JSON.stringify(w.errno)});\n` +
          `await performInstall({ noCache: false, ttsLangs: [] });\n`,
      );
      const engineDir = join(dir, "bin");
      const proc = Bun.spawn([process.execPath, script], {
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", KESHA_ENGINE_BIN: join(engineDir, "kesha-engine") },
        stdout: "ignore",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(stderr).toContain(`error [${w.code}]: `);
      expect(stderr).not.toContain("E_MODEL_DOWNLOAD");
      expect(stderr).toMatch(w.why);
      expect(stderr).toContain(engineDir);
      expect(exitCode).toBe(w.exit);
      expect(existsSync(join(engineDir, "kesha-engine"))).toBe(false);
      expect(readdirSync(engineDir).filter((n) => n.startsWith("kesha-engine.part."))).toEqual([]);
    }, 30_000);
  }
});
