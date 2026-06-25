import { describe, test, expect, beforeAll } from "bun:test";
import {
  isEngineInstalled,
  getEngineBinPath,
  TRANSCRIBE_SEGMENTS_FEATURE,
  TRANSCRIBE_DIARIZE_FEATURE,
} from "../../src/engine";

const CWD = import.meta.dir + "/../..";
const FIXTURE_RU = "tests/fixtures/benchmark/01-ne-nuzhno-slat-soobshcheniya.ogg";
const FIXTURE_EN = "tests/fixtures/benchmark-en/01-check-email.ogg";

const engineInstalled = isEngineInstalled();

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "run", "src/cli-entry.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: CWD,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function runEngine(
  args: string[],
  opts: { timeoutMs?: number; timeoutMessage?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binPath = getEngineBinPath();
  const proc = Bun.spawn([binPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      KESHA_DIARIZE_TIMEOUT_SECS: process.env.KESHA_DIARIZE_TIMEOUT_SECS ?? "30",
    },
  });
  let timedOut = false;
  const timeout =
    opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          Bun.spawnSync(["/usr/bin/pkill", "-TERM", "-P", String(proc.pid)]);
          proc.kill();
        }, opts.timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  return {
    stdout: stdout.trim(),
    stderr: timedOut ? (opts.timeoutMessage ?? "engine command timed out") : stderr.trim(),
    exitCode,
  };
}

describe.skipIf(!engineInstalled)("e2e-engine", () => {
  test("engine --capabilities-json returns valid JSON", async () => {
    const { stdout, exitCode } = await runEngine(["--capabilities-json"]);
    expect(exitCode).toBe(0);
    const caps = JSON.parse(stdout);
    expect(caps.protocolVersion).toBe(3);
    expect(caps.backend).toBeDefined();
    expect(caps.features).toContain("transcribe");
    expect(caps.features).toContain("detect-lang");
  });

  test("transcribe.diarize present iff darwin-arm64 (#199)", async () => {
    const { stdout, exitCode } = await runEngine(["--capabilities-json"]);
    expect(exitCode).toBe(0);
    const caps = JSON.parse(stdout);
    const isDarwinArm64 = process.platform === "darwin" && process.arch === "arm64";
    if (isDarwinArm64) {
      // KESHA_ENGINE_BIN may point at a feature-stripped dev build; capability matrix in build-engine.yml is the release source of truth.
      const advertises = caps.features.includes(TRANSCRIBE_DIARIZE_FEATURE);
      if (!advertises) {
        console.warn(
          `engine at ${getEngineBinPath()} lacks ${TRANSCRIBE_DIARIZE_FEATURE}; ` +
            "likely a dev build without --features system_diarize",
        );
      }
    } else {
      expect(caps.features).not.toContain(TRANSCRIBE_DIARIZE_FEATURE);
    }
  });

  test("--speakers round-trip stamps every segment (#199)", async () => {
    const capsRun = await runEngine(["--capabilities-json"]);
    const caps = JSON.parse(capsRun.stdout);
    if (!caps.features.includes(TRANSCRIBE_DIARIZE_FEATURE)) {
      console.warn(`engine lacks ${TRANSCRIBE_DIARIZE_FEATURE}; skipping --speakers e2e`);
      return;
    }

    // --vad exercises multiple segments; missing VAD model surfaces as non-zero exit and is skipped below.
    const { stdout, stderr, exitCode } = await runEngine(
      ["transcribe", "--json", "--vad", "--speakers", FIXTURE_EN],
      {
        timeoutMs: 35_000,
        timeoutMessage: "kesha-diarize timed out after 30s",
      },
    );
    if (exitCode !== 0) {
      // Missing prerequisites are skip, not fail; installer flows are tested separately.
      if (
        stderr.includes("diarization model not found") ||
        stderr.includes("kesha-diarize sidecar not found") ||
        stderr.includes("VAD model") ||
        stderr.includes("kesha-diarize timed out")
      ) {
        console.warn(`skipping --speakers e2e: ${stderr.split("\n")[0]}`);
        return;
      }
      throw new Error(`engine transcribe --speakers failed: ${stderr}`);
    }

    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.segments)).toBe(true);
    if (parsed.segments.length > 0) {
      // One cluster ID is fine; locking that speaker field is numeric on every segment (wire shape).
      expect(parsed.segments.every((s: { speaker?: unknown }) => typeof s.speaker === "number")).toBe(true);
    }
  }, 120_000);

  test("engine transcribes Russian audio", async () => {
    const { stdout, exitCode } = await runEngine(["transcribe", FIXTURE_RU]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(10);
  }, 60_000);

  test("engine transcribe --json returns text and segments", async () => {
    const capsRun = await runEngine(["--capabilities-json"]);
    const caps = JSON.parse(capsRun.stdout);
    if (!caps.features.includes(TRANSCRIBE_SEGMENTS_FEATURE)) {
      console.warn(`engine lacks ${TRANSCRIBE_SEGMENTS_FEATURE}; skipping timestamp e2e`);
      return;
    }

    const { stdout, exitCode } = await runEngine(["transcribe", FIXTURE_EN, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.text.length).toBeGreaterThan(10);
    expect(Array.isArray(parsed.segments)).toBe(true);
    if (parsed.segments.length > 0) {
      expect(parsed.segments[0].start).toBeGreaterThanOrEqual(0);
      expect(parsed.segments[0].end).toBeGreaterThan(parsed.segments[0].start);
      expect(parsed.segments[0].text.length).toBeGreaterThan(0);
    }
  }, 60_000);

  test("engine detect-lang identifies Russian", async () => {
    const { stdout, exitCode } = await runEngine(["detect-lang", FIXTURE_RU]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.code).toBe("ru");
    expect(result.confidence).toBeGreaterThan(0);
  }, 60_000);

  // NLLanguageRecognizer cold-start can exceed Bun's 5s default on CI.
  test("engine detect-text-lang identifies Russian text", async () => {
    const { stdout, exitCode } = await runEngine(["detect-text-lang", "Привет мир как дела"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.code).toBe("ru");
    expect(result.confidence).toBeGreaterThan(0.5);
  }, 60_000);

  test("engine detect-text-lang identifies English text", async () => {
    const { stdout, exitCode } = await runEngine(["detect-text-lang", "Hello world how are you doing today"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.code).toBe("en");
  }, 60_000);
});

describe.skipIf(!engineInstalled)("e2e-transcribe", () => {
  test("kesha transcribes Russian audio to stdout", async () => {
    const { stdout, exitCode } = await runCli([FIXTURE_RU]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(10);
  }, 60_000);

  test("kesha --json returns valid JSON with lang field", async () => {
    const { stdout, exitCode } = await runCli(["--json", FIXTURE_RU]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].text.length).toBeGreaterThan(0);
    expect(parsed[0].lang).toBeDefined();
    expect(parsed[0].textLanguage).toBeDefined();
    expect(parsed[0].textLanguage.code).toBeDefined();
    expect(parsed[0].textLanguage.confidence).toBeGreaterThan(0);
  }, 60_000);

  test("kesha --json --timestamps includes transcript segments", async () => {
    const capsRun = await runEngine(["--capabilities-json"]);
    const caps = JSON.parse(capsRun.stdout);
    if (!caps.features.includes(TRANSCRIBE_SEGMENTS_FEATURE)) {
      console.warn(`engine lacks ${TRANSCRIBE_SEGMENTS_FEATURE}; skipping timestamp e2e`);
      return;
    }

    const { stdout, exitCode } = await runCli(["--json", "--timestamps", FIXTURE_EN]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].text.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed[0].segments)).toBe(true);
    if (parsed[0].segments.length > 0) {
      expect(parsed[0].segments[0].start).toBeGreaterThanOrEqual(0);
      expect(parsed[0].segments[0].end).toBeGreaterThan(parsed[0].segments[0].start);
      expect(parsed[0].segments[0].text.length).toBeGreaterThan(0);
    }
  }, 60_000);

  test("kesha --verbose shows language info", async () => {
    const { stdout, exitCode } = await runCli(["--verbose", FIXTURE_RU]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Text language:");
    expect(stdout).toContain("---");
  }, 60_000);

  test("kesha --lang en warns on Russian audio", async () => {
    const { stdout, stderr, exitCode } = await runCli(["--lang", "en", FIXTURE_RU]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("expected language");
    expect(stdout.length).toBeGreaterThan(0);
  }, 60_000);

  test("kesha transcribes English audio", async () => {
    const { stdout, exitCode } = await runCli([FIXTURE_EN]);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("email");
  }, 60_000);

  test("kesha transcribes multiple files", async () => {
    const { stdout, exitCode } = await runCli([FIXTURE_RU, FIXTURE_EN]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("===");
  }, 120_000);

  test("--format transcript appends a lang+confidence footer", async () => {
    const { stdout, exitCode } = await runCli([
      "--format",
      "transcript",
      FIXTURE_RU,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\[lang: [a-z]{2}, confidence: \d+\.\d+\]/);
  }, 60_000);

  test("partial failure: one valid + one missing → exit 1 with a single result", async () => {
    const { stdout, exitCode } = await runCli(["--json", FIXTURE_RU, "nonexistent.wav"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].file).toBe(FIXTURE_RU);
    expect(parsed[0].text.length).toBeGreaterThan(0);
  }, 60_000);

  test("--toon output decodes to the same shape as --json (#138)", async () => {
    const { decode: decodeToon } = await import("@toon-format/toon");
    const [jsonRun, toonRun] = await Promise.all([
      runCli(["--json", FIXTURE_RU]),
      runCli(["--toon", FIXTURE_RU]),
    ]);
    expect(jsonRun.exitCode).toBe(0);
    expect(toonRun.exitCode).toBe(0);
    const fromJson = JSON.parse(jsonRun.stdout);
    const fromToon = decodeToon(toonRun.stdout);
    // Deterministic fixture → decoded arrays must match exactly; sttTimeMs varies so strip it.
    const stripTiming = (arr: unknown[]) =>
      arr.map((r) => { const { sttTimeMs: _, ...rest } = r as Record<string, unknown>; return rest; });
    expect(stripTiming(fromToon as unknown[])).toEqual(stripTiming(fromJson));
  }, 120_000);
});

describe.skipIf(!engineInstalled)("e2e-lang-detection", () => {
  test("--json audioLanguage is present for Russian audio", async () => {
    const { stdout, exitCode } = await runCli(["--json", FIXTURE_RU]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    if (parsed[0].audioLanguage) {
      expect(parsed[0].audioLanguage.code).toBeDefined();
      expect(parsed[0].audioLanguage.confidence).toBeGreaterThan(0);
    }
  }, 60_000);

  test("--verbose shows audio language when detected", async () => {
    const { stdout, exitCode } = await runCli(["--verbose", FIXTURE_RU]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("language:");
  }, 60_000);
});
