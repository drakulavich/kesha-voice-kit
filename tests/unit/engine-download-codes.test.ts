import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { writeFileSync } from "fs";
import { install, KeshaError } from "../../src/lib";
import { engineChecksums, installEngine } from "../../src/engine-install";
import { expectServedBody, isolateEngineCache } from "../helpers/fake-engine";
import { tempDir } from "../helpers/temp-dir";

const ENGINE = "#!/bin/sh\nexit 0\n";
const savedFetch = globalThis.fetch;
let restore: () => void = () => {};

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
    }, 30_000);

    test(`Core API install(): ${f.name} rejects as ${f.code}, not E_INTERNAL`, async () => {
      expectServedBody(() => f.served);
      globalThis.fetch = f.fetch;

      const err = await rejectionOf(install());

      expect(err.code).toBe(f.code);
      expect(err.hint).toMatch(f.hint);
    }, 30_000);
  }
});

const CLI_CASES = [
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
    }, 30_000);
  }
});

const SUMS_CASES = [
  { name: "HTTP 503", respond: `new Response("Service Unavailable", { status: 503 })` },
  { name: "HTTP 404", respond: `new Response("Not Found", { status: 404 })` },
  { name: "HTTP 200 with an empty body", respond: `new Response("", { status: 200 })` },
];
const SUMS_HINT = "--engine-version";

function sumsFetch(respond: string): string {
  return `async (input) => String(input instanceof Request ? input.url : input).endsWith("/SHA256SUMS") ? ${respond} : new Response(${JSON.stringify(ENGINE)}, { status: 200 })`;
}

describe("a SHA256SUMS the installer cannot use is E_MODEL_DOWNLOAD with the release hint", () => {
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
        expect(err.hint).toContain(SUMS_HINT);
        expect(err.hint).toContain("https://github.com/drakulavich/kesha-voice-kit/releases");
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
      expect(stderr.slice(stderr.indexOf("hint: "))).toContain(SUMS_HINT);
      expect(exitCode).toBe(1);
    }, 30_000);
  }
});
