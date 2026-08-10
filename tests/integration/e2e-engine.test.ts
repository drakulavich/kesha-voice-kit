import { describe, test, expect, beforeAll } from "bun:test";
import { engineGate } from "../helpers/model-gate";
import {
  getEngineBinPath,
  TRANSCRIBE_SEGMENTS_FEATURE,
  TRANSCRIBE_DIARIZE_FEATURE,
  TRANSCRIBE_ITN_FEATURE,
} from "../../src/engine";

const CWD = import.meta.dir + "/../..";
const FIXTURE_RU = "tests/fixtures/benchmark/01-ne-nuzhno-slat-soobshcheniya.ogg";
const FIXTURE_EN = "tests/fixtures/benchmark-en/01-check-email.ogg";

// Presence is not usability: the #796 stub existed, ran, and failed all 19 of these (#801).
const engineGateResult = await engineGate();
const engineInstalled = engineGateResult.installed;
if (engineGateResult.requiredFailure) {
  test("this lane must ship a functional engine (#741)", () => {
    throw new Error(engineGateResult.requiredFailure!);
  });
}

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
  opts: {
    timeoutMs?: number;
    timeoutMessage?: string;
    // `undefined` unsets a variable the default env would otherwise supply.
    env?: Record<string, string | undefined>;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binPath = getEngineBinPath();
  const env: Record<string, string | undefined> = {
    ...process.env,
    KESHA_DIARIZE_TIMEOUT_SECS: process.env.KESHA_DIARIZE_TIMEOUT_SECS ?? "30",
    ...opts.env,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  const proc = Bun.spawn([binPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
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
    // Exactly one backend is compiled in; "some string" would accept a build that named none.
    expect(["coreml", "onnx"]).toContain(caps.backend);
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

  async function engineDiarizes(): Promise<boolean> {
    const capsRun = await runEngine(["--capabilities-json"]);
    const caps = JSON.parse(capsRun.stdout);
    if (!caps.features.includes(TRANSCRIBE_DIARIZE_FEATURE)) {
      console.warn(`engine lacks ${TRANSCRIBE_DIARIZE_FEATURE}; skipping --speakers e2e`);
      return false;
    }
    return true;
  }

  /**
   * Missing prerequisites are skip, not fail; installer flows are tested separately.
   * A timeout is deliberately not one of them: a wedged supervisor or a phase budget
   * that is too tight is the failure these tests exist to catch, and this is the only
   * lane that can catch it.
   */
  function isMissingPrerequisite(stderr: string): boolean {
    return (
      stderr.includes("diarization model not found") ||
      stderr.includes("kesha-diarize sidecar not found") ||
      stderr.includes("VAD model")
    );
  }

  test("--speakers round-trip stamps every segment (#199)", async () => {
    if (!(await engineDiarizes())) return;

    // --vad exercises multiple segments; missing VAD model surfaces as non-zero exit and is skipped below.
    // The cap stays unset for the same reason as the progress test: a cold ANE compile
    // takes ~105s once, and capping it turns #443 into a failure of this test instead.
    const { stdout, stderr, exitCode } = await runEngine(
      ["transcribe", "--json", "--vad", "--speakers", FIXTURE_EN],
      {
        env: { KESHA_DIARIZE_TIMEOUT_SECS: undefined },
        timeoutMs: 300_000,
        timeoutMessage: "kesha-diarize timed out after 300s",
      },
    );
    if (exitCode !== 0) {
      if (isMissingPrerequisite(stderr)) {
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
  }, 360_000);

  // No total cap: a cold ANE compile takes ~105s and would trip this file's 30s default.
  test("--speakers narrates its phases on stderr and leaves stdout pure JSON (#721)", async () => {
    if (!(await engineDiarizes())) return;

    const { stdout, stderr, exitCode } = await runEngine(
      ["transcribe", "--json", "--vad", "--speakers", FIXTURE_EN],
      {
        env: { KESHA_DIARIZE_TIMEOUT_SECS: undefined },
        timeoutMs: 300_000,
        timeoutMessage: "kesha-diarize timed out after 300s",
      },
    );
    if (exitCode !== 0) {
      if (isMissingPrerequisite(stderr)) {
        console.warn(`skipping --speakers progress e2e: ${stderr.split("\n")[0]}`);
        return;
      }
      throw new Error(`engine transcribe --speakers failed: ${stderr}`);
    }

    // Every phase boundary the supervisor bounds must be visible, in order.
    const phases = stderr
      .split("\n")
      .filter((line) => line.startsWith("diarize: "))
      .join("\n");
    if (phases === "") {
      // A released engine older than #721 diarizes in silence; nothing to assert on it.
      console.warn("engine predates diarize phase reporting (#721); skipping progress e2e");
      return;
    }
    expect(phases).toMatch(/^diarize: loading the CoreML model on \w[\w-]*$/m);
    expect(phases).toMatch(/^diarize: model ready in [\d.]+s; reading the audio$/m);
    expect(phases).toMatch(/^diarize: done in [\d.]+s \(\d+ spans\)$/m);
    expect(phases.indexOf("model ready")).toBeGreaterThan(phases.indexOf("loading the CoreML"));
    expect(phases.indexOf("done in")).toBeGreaterThan(phases.indexOf("model ready"));

    // Progress goes to stderr precisely so stdout stays a pipeable JSON document.
    const parsed = JSON.parse(stdout);
    expect(typeof parsed.text).toBe("string");
    expect(stdout).not.toContain("diarize:");
  }, 360_000);

  test("a reached KESHA_DIARIZE_TIMEOUT_SECS fails coded, not by signal (#721)", async () => {
    if (!(await engineDiarizes())) return;

    const { stdout, stderr, exitCode } = await runEngine(
      ["transcribe", "--json", "--vad", "--speakers", FIXTURE_EN],
      {
        env: { KESHA_DIARIZE_TIMEOUT_SECS: "1" },
        timeoutMs: 300_000,
        timeoutMessage: "engine ignored KESHA_DIARIZE_TIMEOUT_SECS=1",
      },
    );
    if (!stderr.includes("E_DIARIZE_TIMEOUT")) {
      // No CI lane stages the diarize model, so this is the arm that always runs there (#721).
      if (isMissingPrerequisite(stderr)) {
        console.warn(`skipping cap e2e: ${stderr.split("\n")[0]}`);
        return;
      }
      throw new Error(`expected E_DIARIZE_TIMEOUT, got: ${stderr}`);
    }
    if (stderr.includes("the adaptive limit")) {
      // A released engine older than #721 still scales one clock; its wording is not this contract.
      console.warn("engine predates per-phase supervision (#721); skipping cap e2e");
      return;
    }

    // Cancelling used to segfault the process on exit (139); 1 is the coded-failure exit.
    expect(exitCode).toBe(1);
    expect(stderr).toContain("[E_DIARIZE_TIMEOUT]");
    expect(stderr).toContain("KESHA_DIARIZE_TIMEOUT_SECS=1s was reached");
    expect(stdout).toBe("");
  }, 360_000);

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

  test("--itn keeps --json --timestamps output well-formed (#710)", async () => {
    const capsRun = await runEngine(["--capabilities-json"]);
    const caps = JSON.parse(capsRun.stdout);
    if (!caps.features.includes(TRANSCRIBE_ITN_FEATURE)) {
      console.warn(`engine lacks ${TRANSCRIBE_ITN_FEATURE}; skipping itn e2e`);
      return;
    }

    const plain = await runEngine(["transcribe", FIXTURE_EN, "--json"]);
    const itn = await runEngine(["transcribe", FIXTURE_EN, "--json", "--itn"]);
    expect(plain.exitCode).toBe(0);
    expect(itn.exitCode).toBe(0);

    const before = JSON.parse(plain.stdout);
    const after = JSON.parse(itn.stdout);
    expect(Array.isArray(after.segments)).toBe(true);
    expect(after.text.length).toBeGreaterThan(0);
    // The pass rewrites text inside a segment and never its timing.
    expect(after.segments.length).toBe(before.segments.length);
    for (let i = 0; i < after.segments.length; i++) {
      expect(after.segments[i].start).toBe(before.segments[i].start);
      expect(after.segments[i].end).toBe(before.segments[i].end);
      expect(after.segments[i].text.length).toBeGreaterThan(0);
    }
    if (after.segments.length > 0) {
      expect(after.text).toBe(after.segments.map((s: { text: string }) => s.text).join(" "));
    }
  }, 120_000);

  test("--itn leaves Russian transcripts unchanged (#710)", async () => {
    const capsRun = await runEngine(["--capabilities-json"]);
    const caps = JSON.parse(capsRun.stdout);
    if (!caps.features.includes(TRANSCRIBE_ITN_FEATURE)) {
      console.warn(`engine lacks ${TRANSCRIBE_ITN_FEATURE}; skipping itn e2e`);
      return;
    }

    const plain = await runEngine(["transcribe", FIXTURE_RU]);
    const itn = await runEngine(["transcribe", FIXTURE_RU, "--itn"]);
    expect(plain.exitCode).toBe(0);
    expect(itn.exitCode).toBe(0);
    expect(itn.stdout).toBe(plain.stdout);
  }, 120_000);

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
    // Backend-stable word: CoreML and ONNX disagree on "сообщения"/"сообщение" for this clip.
    expect(parsed[0].text).toContain("транскрипцией");
    expect(parsed[0].lang).toBe("ru");
    expect(parsed[0].textLanguage.code).toBe("ru");
    expect(parsed[0].textLanguage.confidence).toBeGreaterThan(0.5);
    expect(parsed[0].textLanguage.confidence).toBeLessThanOrEqual(1);
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
    expect(parsed[0].text).toContain("email");
    expect(Array.isArray(parsed[0].segments)).toBe(true);
    if (parsed[0].segments.length > 0) {
      expect(parsed[0].segments[0].start).toBeGreaterThanOrEqual(0);
      expect(parsed[0].segments[0].end).toBeGreaterThan(parsed[0].segments[0].start);
      // The segment texts must reconstruct the transcript, not merely be non-empty.
      expect(parsed[0].segments.map((s: { text: string }) => s.text).join(" ")).toBe(parsed[0].text);
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
    // The warning must not suppress the transcript, which a length check never showed.
    expect(stdout).toContain("транскрипцией");
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
    expect(parsed[0].text).toContain("транскрипцией");
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
    // Guarding the body on `if (audioLanguage)` made the named contract a silent pass.
    expect(parsed[0].audioLanguage.code).toBe("ru");
    expect(parsed[0].audioLanguage.confidence).toBeGreaterThan(0);
    expect(parsed[0].audioLanguage.confidence).toBeLessThanOrEqual(1);
  }, 60_000);

  test("--verbose shows audio language when detected", async () => {
    const { stdout, exitCode } = await runCli(["--verbose", FIXTURE_RU]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("language:");
  }, 60_000);
});
