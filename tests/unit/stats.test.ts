import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import {
  artifactFromBytes,
  artifactFromFile,
  createStatsRecorder,
  disableStats,
  enableStats,
  exportStats,
  getRecentErrors,
  getStatsStatus,
  getWeekSummary,
  renderErrors,
  renderWeekSummary,
  resetStats,
  resolveStatsDbPath,
  sanitizeStatsError,
  setStatsRetentionDays,
  vacuumStats,
  type StatsWeekSummary,
} from "../../src/stats";

describe("stats storage", () => {
  let dir: string;
  const savedStatsDb = process.env.KESHA_STATS_DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kesha-stats-test-"));
    process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
  });

  afterEach(() => {
    if (savedStatsDb === undefined) delete process.env.KESHA_STATS_DB;
    else process.env.KESHA_STATS_DB = savedStatsDb;
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolveStatsDbPath respects KESHA_STATS_DB", () => {
    expect(resolveStatsDbPath()).toBe(join(dir, "stats.sqlite"));
  });

  test("status is disabled before the database exists", () => {
    const status = getStatsStatus();
    expect(status.enabled).toBe(false);
    expect(status.exists).toBe(false);
    expect(status.runCount).toBe(0);
    expect(status.retentionDays).toBe(90);
  });

  test("enable and disable are idempotent and preserve the database", () => {
    enableStats();
    enableStats();
    expect(existsSync(resolveStatsDbPath())).toBe(true);
    expect(getStatsStatus().enabled).toBe(true);

    disableStats();
    disableStats();
    const status = getStatsStatus();
    expect(status.exists).toBe(true);
    expect(status.enabled).toBe(false);
  }, 15_000);

  test("recorder writes runs, stage timings, artifacts, and errors when enabled", async () => {
    enableStats();
    const recorder = createStatsRecorder("transcribe");
    expect(recorder.enabled).toBe(true);
    recorder.recordArtifact({ kind: "input_audio", format: ".ogg", sizeBytes: 1024 });
    await recorder.timeStage("transcribe", async () => "ok");
    recorder.recordError("transcribe", new Error(`${dir}/secret.ogg failed?token=abc`));
    recorder.finish("failed", 1);

    const status = getStatsStatus();
    const week = getWeekSummary();
    const errors = getRecentErrors();

    expect(status.runCount).toBe(1);
    expect(week.runs).toBe(1);
    expect(week.failures).toBe(1);
    expect(week.inputFiles).toBe(1);
    expect(week.inputBytes).toBe(1024);
    expect(week.sttTimeMs).toBeGreaterThanOrEqual(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).not.toContain(dir);
    expect(errors[0].message).not.toContain("secret.ogg");
  });

  test("recorder is a no-op when disabled", async () => {
    const recorder = createStatsRecorder("say");
    expect(recorder.enabled).toBe(false);
    await recorder.timeStage("tts", async () => "ok");
    recorder.recordError("tts", new Error("boom"));
    recorder.finish("failed", 1);
    expect(getStatsStatus().runCount).toBe(0);
  });

  test("renderers handle empty data", () => {
    expect(renderWeekSummary(getWeekSummary())).toContain("Runs: 0");
    expect(renderErrors(getRecentErrors())).toContain("no recorded errors");
  });

  test("week summary renders stage percentiles, bottlenecks, buckets, and slowest runs", () => {
    enableStats();
    seedStatsRuns([
      {
        command: "transcribe",
        status: "success",
        startedAt: "2026-05-16T10:00:00.000Z",
        finishedAt: "2026-05-16T10:00:02.000Z",
        itemCount: 1,
        stages: [
          { stage: "transcribe", durationMs: 100, status: "success" },
          { stage: "lang_id_audio", durationMs: 30, status: "success" },
        ],
        inputArtifacts: [{ format: "wav", sizeBytes: 500_000, durationMs: 45_000 }],
      },
      {
        command: "say",
        status: "success",
        startedAt: "2026-05-16T11:00:00.000Z",
        finishedAt: "2026-05-16T11:00:02.000Z",
        itemCount: 1,
        stages: [{ stage: "tts", durationMs: 1_500, status: "success" }],
      },
      {
        command: "transcribe",
        status: "failed",
        startedAt: "2026-05-16T12:00:00.000Z",
        finishedAt: "2026-05-16T12:00:05.000Z",
        itemCount: 2,
        stages: [
          { stage: "transcribe", durationMs: 3_000, status: "failed" },
          { stage: "lang_id_text", durationMs: 100, status: "success" },
        ],
        inputArtifacts: [{ format: "mp3", sizeBytes: 15 * 1024 * 1024, durationMs: 15 * 60_000 }],
      },
      {
        command: "say",
        status: "success",
        startedAt: "2026-04-01T10:00:00.000Z",
        finishedAt: "2026-04-01T10:00:20.000Z",
        itemCount: 1,
        stages: [{ stage: "tts", durationMs: 20_000, status: "success" }],
      },
    ]);

    const summary = getWeekSummary(new Date("2026-05-17T00:00:00.000Z"));
    const rendered = renderWeekSummary(summary);

    expect(summary.runs).toBe(3);
    expect(summary.stageBreakdown[0]).toMatchObject({
      stage: "transcribe",
      count: 2,
      failed: 1,
      totalMs: 3_100,
      p50Ms: 100,
      p95Ms: 3_000,
      p99Ms: 3_000,
    });
    expect(rendered).toContain("Stage breakdown:");
    expect(rendered).toContain("transcribe: count 2, failed 1, total 3s, p50 100ms, p95 3s, p99 3s");
    expect(rendered).toContain("Bottlenecks:");
    expect(rendered).toContain("Total time: transcribe 3s, tts 2s");
    expect(rendered).toContain("p95 latency: transcribe 3s, tts 2s");
    expect(rendered).toContain("Input shape:");
    expect(rendered).toContain("Format: mp3 1, wav 1");
    expect(rendered).toContain("Size: <1 MB 1, 10-100 MB 1");
    expect(rendered).toContain("Duration: <1 min 1, 10-60 min 1");
    expect(rendered).toContain("Slowest anonymous runs:");
    expect(rendered).toContain("transcribe failed, 2 item(s), 5s | transcribe 3s failed");
    expect(rendered).not.toContain("secret");
  });

  test("exports content-free JSON and CSV", () => {
    enableStats();
    const secretPath = `${dir}/private-recording.wav`;
    seedStatsRun({
      command: "transcribe",
      status: "failed",
      startedAt: "2026-05-16T10:00:00.000Z",
      finishedAt: "2026-05-16T10:00:01.000Z",
      itemCount: 1,
      stages: [{ stage: "transcribe", durationMs: 100, status: "failed" }],
      inputArtifacts: [{ format: "wav", sizeBytes: 1234, durationMs: 2000 }],
      error: new Error(`${secretPath} failed with {"text":"private words"}`),
    });

    const json = exportStats("json");
    const parsed = JSON.parse(json);
    expect(parsed.privacy.contentFree).toBe(true);
    expect(parsed.privacy.neverStored).toContain("transcripts");
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.artifacts[0]).toMatchObject({ kind: "input_audio", format: "wav", sizeBytes: 1234 });
    expect(json).not.toContain(secretPath);
    expect(json).not.toContain("private-recording.wav");
    expect(json).not.toContain("private words");

    const csv = exportStats("csv");
    expect(csv).toContain("table,id,run_id");
    expect(csv).toContain("runs,");
    expect(csv).toContain("artifacts,");
    expect(csv).toContain("stage_timings,");
    expect(csv).toContain("errors,");
    expect(csv).not.toContain(secretPath);
    expect(csv).not.toContain("private-recording.wav");
    expect(csv).not.toContain("private words");
  });

  test("reset deletes stats records but preserves settings", () => {
    enableStats();
    setStatsRetentionDays(30);
    seedStatsRun({
      command: "say",
      status: "success",
      startedAt: "2026-05-16T10:00:00.000Z",
      finishedAt: "2026-05-16T10:00:01.000Z",
      itemCount: 1,
      stages: [{ stage: "tts", durationMs: 100, status: "success" }],
    });

    const result = resetStats();
    const status = getStatsStatus();

    expect(result.runs).toBe(1);
    expect(result.stageTimings).toBe(1);
    expect(status.enabled).toBe(true);
    expect(status.retentionDays).toBe(30);
    expect(status.runCount).toBe(0);
  });

  test("reset is a no-op before the database exists", () => {
    const result = resetStats();

    expect(result).toEqual({ runs: 0, artifacts: 0, stageTimings: 0, errors: 0 });
    expect(existsSync(resolveStatsDbPath())).toBe(false);
  });

  test("retention prunes old runs before recording new stats", () => {
    enableStats();
    setStatsRetentionDays(7);
    seedStatsRun({
      command: "transcribe",
      status: "success",
      startedAt: "2020-01-01T00:00:00.000Z",
      finishedAt: "2020-01-01T00:00:01.000Z",
      itemCount: 1,
      stages: [{ stage: "transcribe", durationMs: 100, status: "success" }],
      inputArtifacts: [{ format: "wav", sizeBytes: 100, durationMs: 1000 }],
    });
    seedStatsRun({
      command: "say",
      status: "success",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      itemCount: 1,
      stages: [{ stage: "tts", durationMs: 100, status: "success" }],
    });

    const recorder = createStatsRecorder("say");
    recorder.finish("success", 1);

    const exported = JSON.parse(exportStats("json"));
    expect(exported.runs.map((run: { command: string }) => run.command)).not.toContain("transcribe");
    expect(exported.artifacts).toHaveLength(0);
    expect(getStatsStatus().retentionDays).toBe(7);
  });

  test("vacuum returns database size information", () => {
    enableStats();
    seedStatsRun({
      command: "say",
      status: "success",
      startedAt: "2026-05-16T10:00:00.000Z",
      finishedAt: "2026-05-16T10:00:01.000Z",
      itemCount: 1,
      stages: [{ stage: "tts", durationMs: 100, status: "success" }],
    });

    const result = vacuumStats();

    expect(result.dbPath).toBe(resolveStatsDbPath());
    expect(result.beforeBytes).toBeGreaterThan(0);
    expect(result.afterBytes).toBeGreaterThan(0);
    expect(getStatsStatus().runCount).toBe(1);
  });

  test("vacuum is a no-op before the database exists", () => {
    const result = vacuumStats();

    expect(result.dbPath).toBe(resolveStatsDbPath());
    expect(result.beforeBytes).toBe(0);
    expect(result.afterBytes).toBe(0);
    expect(existsSync(resolveStatsDbPath())).toBe(false);
  });
});

describe("week summary aggregation", () => {
  let dir: string;
  const savedStatsDb = process.env.KESHA_STATS_DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kesha-stats-agg-"));
    process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
  });

  afterEach(() => {
    if (savedStatsDb === undefined) delete process.env.KESHA_STATS_DB;
    else process.env.KESHA_STATS_DB = savedStatsDb;
    rmSync(dir, { recursive: true, force: true });
  });

  const NOW = new Date("2026-05-17T00:00:00.000Z");

  test("counters, sums and buckets are computed from the week's rows", () => {
    enableStats();
    seedStatsRuns([
      {
        command: "transcribe",
        status: "success",
        startedAt: "2026-05-16T10:00:00.000Z",
        finishedAt: "2026-05-16T10:00:02.000Z",
        itemCount: 1,
        stages: [
          { stage: "transcribe", durationMs: 100, status: "success" },
          { stage: "lang_id_audio", durationMs: 30, status: "success" },
        ],
        inputArtifacts: [
          { format: "wav", sizeBytes: 1024 * 1024, durationMs: 60_000 },
          { format: "wav", sizeBytes: 1000, durationMs: 400 },
        ],
      },
      {
        command: "say",
        status: "success",
        startedAt: "2026-05-16T11:00:00.000Z",
        finishedAt: "2026-05-16T11:00:07.000Z",
        itemCount: 1,
        stages: [{ stage: "tts", durationMs: 1_500, status: "success" }],
        inputArtifacts: [{ format: null, sizeBytes: null, durationMs: null }],
      },
      {
        command: "transcribe",
        status: "failed",
        startedAt: "2026-05-16T12:00:00.000Z",
        finishedAt: "2026-05-16T12:00:05.000Z",
        itemCount: 2,
        stages: [
          { stage: "transcribe", durationMs: 3_000, status: "failed" },
          { stage: "tts", durationMs: 500, status: "success" },
        ],
        inputArtifacts: [
          { format: "mp3", sizeBytes: 10 * 1024 * 1024, durationMs: 600_000 },
          { format: "mp3", sizeBytes: 100 * 1024 * 1024, durationMs: 3_600_000 },
        ],
      },
    ]);

    const summary = getWeekSummary(NOW);

    expect(summary.runs).toBe(3);
    expect(summary.successes).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.inputFiles).toBe(5);
    expect(summary.inputBytes).toBe(1024 * 1024 + 1000 + 10 * 1024 * 1024 + 100 * 1024 * 1024);
    expect(summary.inputDurationMs).toBe(60_000 + 400 + 600_000 + 3_600_000);
    expect(summary.sttTimeMs).toBe(3_100);
    expect(summary.ttsTimeMs).toBe(2_000);
    expect(summary.hasInputDurationData).toBe(true);

    expect(summary.stageBreakdown).toEqual([
      { stage: "transcribe", count: 2, failed: 1, totalMs: 3_100, p50Ms: 100, p95Ms: 3_000, p99Ms: 3_000 },
      { stage: "tts", count: 2, failed: 0, totalMs: 2_000, p50Ms: 500, p95Ms: 1_500, p99Ms: 1_500 },
      { stage: "lang_id_audio", count: 1, failed: 0, totalMs: 30, p50Ms: 30, p95Ms: 30, p99Ms: 30 },
    ]);

    // Ties break alphabetically so the order does not drift with insertion order.
    expect(summary.inputFormats).toEqual([
      { label: "mp3", count: 2 },
      { label: "wav", count: 2 },
      { label: "unknown", count: 1 },
    ]);
    // Exactly on a boundary belongs to the bucket above it.
    expect(summary.inputSizeBuckets).toEqual([
      { label: "unknown", count: 1 },
      { label: "<1 MB", count: 1 },
      { label: "1-10 MB", count: 1 },
      { label: "10-100 MB", count: 1 },
      { label: "100 MB+", count: 1 },
    ]);
    expect(summary.inputDurationBuckets).toEqual([
      { label: "<1 min", count: 1 },
      { label: "1-10 min", count: 1 },
      { label: "10-60 min", count: 1 },
      { label: "60 min+", count: 1 },
    ]);
  });

  test("artifacts without a measured duration leave the duration breakdown empty", () => {
    enableStats();
    seedStatsRun({
      command: "transcribe",
      status: "success",
      startedAt: "2026-05-16T10:00:00.000Z",
      finishedAt: "2026-05-16T10:00:01.000Z",
      itemCount: 1,
      stages: [],
      inputArtifacts: [{ format: "wav", sizeBytes: 10, durationMs: null }],
    });

    const summary = getWeekSummary(NOW);
    expect(summary.hasInputDurationData).toBe(false);
    expect(summary.inputDurationBuckets).toEqual([]);
    expect(renderWeekSummary(summary)).toContain("Duration: n/a");
  });

  test("negative durations and sizes are clamped, never subtracted", () => {
    enableStats();
    seedStatsRun({
      command: "transcribe",
      status: "success",
      startedAt: "2026-05-16T10:00:00.000Z",
      finishedAt: "2026-05-16T10:00:01.000Z",
      itemCount: 1,
      stages: [
        { stage: "transcribe", durationMs: -500, status: "success" },
        { stage: "transcribe", durationMs: 200, status: "success" },
      ],
      inputArtifacts: [{ format: "wav", sizeBytes: -100, durationMs: -100 }],
    });

    const summary = getWeekSummary(NOW);
    expect(summary.sttTimeMs).toBe(200);
    expect(summary.stageBreakdown[0]).toMatchObject({ totalMs: 200, p50Ms: 0, p95Ms: 200 });
    expect(summary.inputBytes).toBe(0);
    expect(summary.inputDurationMs).toBe(0);
  });

  test("the five slowest finished runs are reported, longest first", () => {
    enableStats();
    seedStatsRuns([
      ...[1, 2, 3, 4, 5, 6].map((seconds) => ({
        command: "transcribe" as const,
        status: "success" as const,
        startedAt: `2026-05-16T1${seconds}:00:00.000Z`,
        finishedAt: `2026-05-16T1${seconds}:00:0${seconds}.000Z`,
        itemCount: seconds,
        stages: [],
      })),
      {
        command: "say",
        status: "success",
        startedAt: "2026-05-16T09:00:00.000Z",
        finishedAt: null,
        itemCount: 99,
        stages: [{ stage: "tts", durationMs: 999_999, status: "success" }],
      },
    ]);

    const slowest = getWeekSummary(NOW).slowestRuns;
    expect(slowest).toHaveLength(5);
    expect(slowest.map((run) => run.durationMs)).toEqual([6_000, 5_000, 4_000, 3_000, 2_000]);
    // A run still in flight has no duration to compare, so it is not a candidate.
    expect(slowest.map((run) => run.itemCount)).not.toContain(99);
  });

  test("a run's stages are listed longest first, and a clock that went backwards is zero", () => {
    enableStats();
    seedStatsRuns([
      {
        command: "transcribe",
        status: "success",
        startedAt: "2026-05-16T10:00:05.000Z",
        finishedAt: "2026-05-16T10:00:00.000Z",
        itemCount: 1,
        stages: [
          { stage: "lang_id_audio", durationMs: 200, status: "success" },
          { stage: "transcribe", durationMs: 900, status: "failed" },
          { stage: "decode", durationMs: 200, status: "success" },
        ],
      },
      {
        command: "say",
        status: "success",
        startedAt: "2026-05-16T11:00:00.000Z",
        finishedAt: null,
        itemCount: 7,
        stages: [],
      },
    ]);

    const summary = getWeekSummary(NOW);
    expect(summary.slowestRuns).toHaveLength(1);
    const run = summary.slowestRuns[0];
    expect(run.durationMs).toBe(0);
    expect(run.stages).toEqual([
      { stage: "transcribe", durationMs: 900, status: "failed" },
      { stage: "decode", durationMs: 200, status: "success" },
      { stage: "lang_id_audio", durationMs: 200, status: "success" },
    ]);
  });

  test("percentiles index into the sorted sample, not near it", () => {
    enableStats();
    seedStatsRun({
      command: "transcribe",
      status: "success",
      startedAt: "2026-05-16T10:00:00.000Z",
      finishedAt: "2026-05-16T10:00:01.000Z",
      itemCount: 1,
      stages: [100, 30, 60, 10, 90, 40, 80, 20, 70, 50].map((durationMs) => ({
        stage: "transcribe",
        durationMs,
        status: "success" as const,
      })),
    });

    expect(getWeekSummary(NOW).stageBreakdown[0]).toMatchObject({
      count: 10,
      totalMs: 550,
      p50Ms: 50,
      p95Ms: 100,
      p99Ms: 100,
    });
  });

  test("a run whose timestamps do not parse has no duration and sorts last", () => {
    enableStats();
    seedStatsRuns([
      {
        command: "transcribe",
        status: "success",
        startedAt: "2026-05-16T10:00:00.000Z",
        finishedAt: "whenever",
        itemCount: 1,
        stages: [],
      },
      {
        command: "say",
        status: "success",
        startedAt: "2026-05-16T11:00:00.000Z",
        finishedAt: "2026-05-16T11:00:01.000Z",
        itemCount: 2,
        stages: [],
      },
    ]);

    expect(getWeekSummary(NOW).slowestRuns.map((run) => run.durationMs)).toEqual([1_000, null]);
  });

  test("with no database at all every counter reads zero", () => {
    const summary = getWeekSummary(NOW);
    expect(summary).toEqual({
      runs: 0,
      successes: 0,
      failures: 0,
      inputFiles: 0,
      inputBytes: 0,
      inputDurationMs: 0,
      sttTimeMs: 0,
      ttsTimeMs: 0,
      stageBreakdown: [],
      inputFormats: [],
      inputSizeBuckets: [],
      inputDurationBuckets: [],
      hasInputDurationData: false,
      slowestRuns: [],
    });
  });

  test("artifact formats are recorded as a bare lowercase extension", () => {
    enableStats();
    const recorder = createStatsRecorder("transcribe");
    recorder.recordArtifact({ kind: "input_audio", format: ".OGG", sizeBytes: 10 });
    recorder.recordArtifact({ kind: "input_audio", sizeBytes: 20 });
    recorder.finish("success", 2);

    expect(getWeekSummary().inputFormats).toEqual([
      { label: "ogg", count: 1 },
      { label: "unknown", count: 1 },
    ]);
  });
});

describe("the recorder writes what it is handed", () => {
  let dir: string;
  const savedStatsDb = process.env.KESHA_STATS_DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kesha-stats-recorder-"));
    process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
  });

  afterEach(() => {
    if (savedStatsDb === undefined) delete process.env.KESHA_STATS_DB;
    else process.env.KESHA_STATS_DB = savedStatsDb;
    rmSync(dir, { recursive: true, force: true });
  });

  test("optional artifact and error fields survive the round trip, and absent ones are null", () => {
    enableStats();
    const recorder = createStatsRecorder("transcribe");
    recorder.recordArtifact({
      kind: "input_audio",
      format: "wav",
      sizeBytes: 100,
      durationMs: 200,
      sampleRate: 16_000,
      channels: 2,
    });
    recorder.recordArtifact({ kind: "output_audio" });
    recorder.recordError("transcribe", new Error("boom"), "E_DECODE");
    recorder.recordError("tts", new Error("boom"));
    recorder.finish("failed");

    const exported = JSON.parse(exportStats("json"));
    expect(exported.artifacts[0]).toMatchObject({
      kind: "input_audio",
      format: "wav",
      sizeBytes: 100,
      durationMs: 200,
      sampleRate: 16_000,
      channels: 2,
    });
    expect(exported.artifacts[1]).toMatchObject({
      kind: "output_audio",
      format: null,
      sizeBytes: null,
      durationMs: null,
      sampleRate: null,
      channels: null,
    });
    expect(exported.errors.map((e: { errorCode: string | null }) => e.errorCode)).toEqual([
      "E_DECODE",
      null,
    ]);
    // finish() without an item count records none rather than inventing one.
    expect(exported.runs[0].itemCount).toBe(0);
  });

  test("a disabled database still yields a recorder that writes nothing", () => {
    enableStats();
    disableStats();
    const recorder = createStatsRecorder("say");
    expect(recorder.enabled).toBe(false);
    recorder.finish("success", 1);
    expect(getStatsStatus().runCount).toBe(0);
  });

  test("an export from an untouched install is empty but still states the contract", () => {
    const exported = JSON.parse(exportStats("json"));
    expect(exported.runs).toEqual([]);
    expect(exported.artifacts).toEqual([]);
    expect(exported.stageTimings).toEqual([]);
    expect(exported.errors).toEqual([]);
    expect(exported.privacy.contentFree).toBe(true);
    expect(exported.retentionDays).toBe(90);
  });
});

describe("artifact inputs", () => {
  test("a file contributes its extension and size; anything else contributes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-stats-artifact-"));
    try {
      const file = join(dir, "clip.WAV");
      writeFileSync(file, "x".repeat(42));

      expect(artifactFromFile(file, "input_audio")).toEqual({
        kind: "input_audio",
        format: ".WAV",
        sizeBytes: 42,
      });
      expect(artifactFromFile(dir, "input_audio")).toBeNull();
      expect(artifactFromFile(join(dir, "gone.wav"), "input_audio")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a byte count is recorded as given", () => {
    expect(artifactFromBytes(512, "output_audio", "wav")).toEqual({
      kind: "output_audio",
      format: "wav",
      sizeBytes: 512,
    });
    expect(artifactFromBytes(0, "output_audio")).toEqual({
      kind: "output_audio",
      format: undefined,
      sizeBytes: 0,
    });
  });
});

describe("the default database location", () => {
  const savedStatsDb = process.env.KESHA_STATS_DB;

  afterEach(() => {
    if (savedStatsDb === undefined) delete process.env.KESHA_STATS_DB;
    else process.env.KESHA_STATS_DB = savedStatsDb;
  });

  test("falls back to this platform's application data directory", () => {
    delete process.env.KESHA_STATS_DB;
    const path = resolveStatsDbPath();
    expect(path.endsWith(join("kesha", "stats.sqlite"))).toBe(true);
    if (process.platform === "darwin") {
      expect(path).toBe(join(homedir(), "Library", "Application Support", "kesha", "stats.sqlite"));
    } else if (process.platform !== "win32") {
      expect(path).toBe(
        join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kesha", "stats.sqlite"),
      );
    }
  });
});

describe("renderWeekSummary", () => {
  function weekSummary(overrides: Partial<StatsWeekSummary> = {}): StatsWeekSummary {
    return {
      runs: 0,
      successes: 0,
      failures: 0,
      inputFiles: 0,
      inputBytes: 0,
      inputDurationMs: 0,
      sttTimeMs: 0,
      ttsTimeMs: 0,
      stageBreakdown: [],
      inputFormats: [],
      inputSizeBuckets: [],
      inputDurationBuckets: [],
      hasInputDurationData: false,
      slowestRuns: [],
      ...overrides,
    };
  }

  test("the headline counters carry their figures", () => {
    const output = renderWeekSummary(
      weekSummary({
        runs: 5,
        successes: 3,
        failures: 2,
        inputFiles: 4,
        inputBytes: 2048,
        inputDurationMs: 5_000,
        ttsTimeMs: 1_400,
      }),
    );
    expect(output).toContain("Runs: 5 (3 success, 2 failed)");
    expect(output).toContain("Input files: 4");
    expect(output).toContain("Input audio: 5s");
    expect(output).toContain("Input size: 2.0 KB");
    expect(output).toContain("TTS time: 1s");
  });

  test("the realtime factor is input audio over STT time, and n/a without both", () => {
    expect(
      renderWeekSummary(weekSummary({ inputDurationMs: 60_000, sttTimeMs: 20_000 })),
    ).toContain("STT time: 20s (3.0x realtime)");
    expect(renderWeekSummary(weekSummary({ inputDurationMs: 60_000 }))).toContain("(n/a realtime)");
    expect(renderWeekSummary(weekSummary({ sttTimeMs: 20_000 }))).toContain("(n/a realtime)");
  });

  test("durations are broken into hours, minutes and seconds", () => {
    const cases: Array<[number, string]> = [
      [400, "400ms"],
      [1_000, "1s"],
      [65_000, "1m 5s"],
      [3_725_000, "1h 2m 5s"],
    ];
    for (const [ms, expected] of cases) {
      expect(renderWeekSummary(weekSummary({ inputDurationMs: ms }))).toContain(
        `Input audio: ${expected}`,
      );
    }
  });

  test("a week with nothing in it says so section by section", () => {
    const output = renderWeekSummary(weekSummary());
    expect(output).toContain("no stage timings recorded");
    expect(output).toContain("no bottlenecks recorded");
    expect(output).toContain("no completed runs recorded");
    expect(output).toContain("Format: n/a");
    expect(output).toContain("Size: n/a");
    expect(output).toContain("Duration: n/a");
  });

  test("stage rows and bottlenecks replace the empty-state lines", () => {
    const output = renderWeekSummary(
      weekSummary({
        stageBreakdown: [
          { stage: "transcribe", count: 2, failed: 1, totalMs: 4_000, p50Ms: 1_000, p95Ms: 3_000, p99Ms: 3_400 },
          { stage: "tts", count: 1, failed: 0, totalMs: 2_000, p50Ms: 2_000, p95Ms: 2_000, p99Ms: 2_000 },
          { stage: "lang_id", count: 4, failed: 0, totalMs: 2_000, p50Ms: 400, p95Ms: 400, p99Ms: 400 },
          { stage: "warmup", count: 1, failed: 0, totalMs: 5, p50Ms: 5, p95Ms: 5, p99Ms: 5 },
        ],
        inputFormats: [{ label: "wav", count: 2 }],
        inputSizeBuckets: [{ label: "<1 MB", count: 2 }],
        inputDurationBuckets: [{ label: "1-10 min", count: 2 }],
        hasInputDurationData: true,
      }),
    );
    expect(output).toContain(
      "transcribe: count 2, failed 1, total 4s, p50 1s, p95 3s, p99 3s",
    );
    expect(output).toContain("Total time: transcribe 4s, lang_id 2s, tts 2s");
    expect(output).toContain("p95 latency: transcribe 3s, tts 2s, lang_id 400ms");
    expect(output).toContain("Format: wav 2");
    expect(output).toContain("Size: <1 MB 2");
    expect(output).toContain("Duration: 1-10 min 2");
    expect(output).not.toContain("no stage timings recorded");
    expect(output).not.toContain("no bottlenecks recorded");
    // Bottlenecks are the top three; the rest stay in the stage breakdown only.
    expect(output).toContain("warmup: count 1");
    expect(output).not.toContain("warmup 5ms");
  });

  test("each slow run lists its stages, or says it has none", () => {
    const output = renderWeekSummary(
      weekSummary({
        slowestRuns: [
          {
            command: "transcribe",
            status: "failed",
            durationMs: 5_000,
            itemCount: 2,
            stages: [
              { stage: "transcribe", durationMs: 3_000, status: "failed" },
              { stage: "lang_id", durationMs: 100, status: "success" },
            ],
          },
          { command: "say", status: "success", durationMs: null, itemCount: 1, stages: [] },
        ],
      }),
    );
    expect(output).toContain(
      "transcribe failed, 2 item(s), 5s | transcribe 3s failed, lang_id 100ms success",
    );
    expect(output).toContain("say success, 1 item(s), 0ms | no stages recorded");
    expect(output).not.toContain("no completed runs recorded");
  });
});

describe("renderErrors", () => {
  test("each row names when it happened, what ran, and what failed", () => {
    const rows = renderErrors([
      {
        occurredAt: "2026-05-16T10:00:00.000Z",
        command: "transcribe",
        stage: "transcribe",
        errorClass: "Error",
        errorCode: "E_DECODE",
        message: "decode failed",
      },
      {
        occurredAt: "2026-05-16T11:00:00.000Z",
        command: null,
        stage: null,
        errorClass: "TypeError",
        errorCode: null,
        message: "no run attached",
      },
      {
        occurredAt: "2026-05-16T12:00:00.000Z",
        command: "say",
        stage: "tts",
        errorClass: null,
        errorCode: null,
        message: "nothing known",
      },
    ]).split("\n");

    // The error code wins over the class, and both falling through still leaves a label.
    expect(rows.slice(1)).toEqual([
      "2026-05-16T10:00:00.000Z | transcribe | transcribe | E_DECODE | decode failed",
      "2026-05-16T11:00:00.000Z | unknown | unknown | TypeError | no run attached",
      "2026-05-16T12:00:00.000Z | say | tts | error | nothing known",
    ]);
  });
});

describe("stats retention settings", () => {
  let dir: string;
  const saved = {
    KESHA_STATS_DB: process.env.KESHA_STATS_DB,
    KESHA_STATS_RETENTION_DAYS: process.env.KESHA_STATS_RETENTION_DAYS,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kesha-stats-retention-"));
    process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
    delete process.env.KESHA_STATS_RETENTION_DAYS;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("retention accepts whole positive days or off, and nothing else", () => {
    enableStats();
    expect(() => setStatsRetentionDays(0)).toThrow();
    expect(() => setStatsRetentionDays(-1)).toThrow();
    expect(() => setStatsRetentionDays(1.5)).toThrow();

    setStatsRetentionDays(1);
    expect(getStatsStatus().retentionDays).toBe(1);
    setStatsRetentionDays(null);
    expect(getStatsStatus().retentionDays).toBeNull();
  });

  test("the environment override spells off three ways and falls back on nonsense", () => {
    const cases: Array<[string, number | null]> = [
      [" OFF ", null],
      ["none", null],
      ["never", null],
      ["12", 12],
      ["banana", 90],
      ["0", 90],
      ["1.5", 90],
    ];
    for (const [raw, expected] of cases) {
      process.env.KESHA_STATS_RETENTION_DAYS = raw;
      expect(getStatsStatus().retentionDays).toBe(expected as number);
    }
  });

  test("retention off keeps runs older than any window", () => {
    enableStats();
    setStatsRetentionDays(null);
    seedStatsRun({
      command: "transcribe",
      status: "success",
      startedAt: "2020-01-01T00:00:00.000Z",
      finishedAt: "2020-01-01T00:00:01.000Z",
      itemCount: 1,
      stages: [{ stage: "transcribe", durationMs: 100, status: "success" }],
    });

    createStatsRecorder("say").finish("success", 1);
    const runs = JSON.parse(exportStats("json")).runs as Array<{ startedAt: string }>;
    expect(runs.map((run) => run.startedAt)).toContain("2020-01-01T00:00:00.000Z");
  });
});

describe("stats export contracts", () => {
  let dir: string;
  const savedStatsDb = process.env.KESHA_STATS_DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kesha-stats-export-"));
    process.env.KESHA_STATS_DB = join(dir, "stats.sqlite");
  });

  afterEach(() => {
    if (savedStatsDb === undefined) delete process.env.KESHA_STATS_DB;
    else process.env.KESHA_STATS_DB = savedStatsDb;
    rmSync(dir, { recursive: true, force: true });
  });

  test("the CSV header is the whole column contract, in order", () => {
    enableStats();
    expect(exportStats("csv").split("\n")[0]).toBe(
      "table,id,run_id,command,kind,stage,status,started_at,finished_at,occurred_at," +
        "duration_ms,format,size_bytes,sample_rate,channels,error_class,error_code," +
        "sanitized_message,app_version,item_count",
    );
  });

  test("the export states everything stats never stores", () => {
    enableStats();
    expect(JSON.parse(exportStats("json")).privacy).toEqual({
      contentFree: true,
      neverStored: [
        "audio bytes",
        "transcripts",
        "input text",
        "output text",
        "file names",
        "full file paths",
        "raw stdout",
        "raw stderr",
        "environment variables",
        "model files",
      ],
    });
  });

  test("every row carries one cell per column, blank where the table has no such field", () => {
    enableStats();
    seedStatsRun({
      command: "transcribe",
      status: "failed",
      startedAt: "2026-05-16T10:00:00.000Z",
      finishedAt: "2026-05-16T10:00:01.000Z",
      itemCount: 1,
      stages: [],
    });

    const lines = exportStats("csv").trim().split("\n");
    const header = lines[0].split(",");
    const runRow = lines.find((line) => line.startsWith("runs,"))!.split(",");

    expect(runRow).toHaveLength(header.length);
    expect(runRow[header.indexOf("command")]).toBe("transcribe");
    expect(runRow[header.indexOf("status")]).toBe("failed");
    expect(runRow[header.indexOf("item_count")]).toBe("1");
    expect(runRow[header.indexOf("kind")]).toBe("");
    expect(runRow[header.indexOf("size_bytes")]).toBe("");
  });

  test("a cell containing a comma or a quote is quoted rather than splitting the row", () => {
    enableStats();
    seedStatsRun({
      command: "transcribe",
      status: "failed",
      startedAt: "2026-05-16T10:00:00.000Z",
      finishedAt: "2026-05-16T10:00:01.000Z",
      itemCount: 1,
      stages: [],
      error: new Error('one, two "three"'),
    });

    expect(exportStats("csv")).toContain('"one, two ""three"""');
  });
});

describe("sanitizeStatsError", () => {
  test("replaces the sensitive span rather than dropping the message", () => {
    expect(
      sanitizeStatsError(new Error('failed {"text":"secret"} via https://example.com/a?token=x'))
        .message,
    ).toBe('failed {"text":"<redacted>"} via https://example.com/a?<redacted>');
    expect(
      sanitizeStatsError(new Error('{"transcript":"a"} {"stdout":"b"} {"stderr":"c"}')).message,
    ).toBe('{"transcript":"<redacted>"} {"stdout":"<redacted>"} {"stderr":"<redacted>"}');
    expect(sanitizeStatsError(new Error("open /Users/alice/a.wav failed")).message).toBe(
      "open <path> failed",
    );
    expect(sanitizeStatsError(new Error("open C:\\Users\\bob\\a.wav failed")).message).toBe(
      "open <path> failed",
    );
  });

  test("falls back to the class when there is no message, and reports non-errors", () => {
    expect(sanitizeStatsError(new Error("")).message).toBe("Error");
    expect(sanitizeStatsError("plain failure")).toEqual({
      errorClass: "string",
      message: "plain failure",
    });
  });

  test("a message that is nothing but a stack frame falls back to the class", () => {
    expect(sanitizeStatsError(new Error("    at frame (file.ts:1:1)")).message).toBe("Error");
  });

  test("truncation starts one character past the limit", () => {
    const exact = "y".repeat(300);
    expect(sanitizeStatsError(new Error(exact)).message).toBe(exact);

    const truncated = sanitizeStatsError(new Error("y".repeat(301))).message;
    expect(truncated).toHaveLength(300);
    expect(truncated.endsWith("...")).toBe(true);
  });

  test("removes paths, query strings, stack lines, and truncates long messages", () => {
    const long = "x".repeat(400);
    const err = new Error(`/Users/alice/audio/private.wav failed at https://example.com/a?token=secret {"text":"private transcript"}\n    at frame\n${long}`);
    const sanitized = sanitizeStatsError(err);
    expect(sanitized.errorClass).toBe("Error");
    expect(sanitized.message).not.toContain("/Users/alice");
    expect(sanitized.message).not.toContain("private.wav");
    expect(sanitized.message).not.toContain("token=secret");
    expect(sanitized.message).not.toContain("private transcript");
    expect(sanitized.message).not.toContain("at frame");
    expect(sanitized.message.length).toBeLessThanOrEqual(300);
  });
});

interface SeededRun {
  command: "transcribe" | "say";
  status: "success" | "failed";
  startedAt: string;
  finishedAt: string | null;
  itemCount: number;
  stages: Array<{ stage: string; durationMs: number; status: "success" | "failed" }>;
  inputArtifacts?: Array<{
    format: string | null;
    sizeBytes: number | null;
    durationMs: number | null;
  }>;
  error?: Error;
}

function seedStatsRun(input: SeededRun): void {
  seedStatsRuns([input]);
}

function seedStatsRuns(inputs: SeededRun[]): void {
  const db = new Database(resolveStatsDbPath());
  try {
    db.exec("begin");
    try {
      for (const input of inputs) {
        const run = db.query(
          `insert into runs
            (command, started_at, finished_at, status, app_version, item_count)
           values (?, ?, ?, ?, 'test', ?)
           returning id`,
        ).get(input.command, input.startedAt, input.finishedAt, input.status, input.itemCount) as { id: number };

        for (const artifact of input.inputArtifacts ?? []) {
          db.query(
            `insert into artifacts
              (run_id, kind, format, size_bytes, duration_ms, sample_rate, channels)
             values (?, 'input_audio', ?, ?, ?, null, null)`,
          ).run(run.id, artifact.format, artifact.sizeBytes, artifact.durationMs);
        }

        for (const stage of input.stages) {
          db.query(
            `insert into stage_timings
              (run_id, stage, started_at, duration_ms, status)
             values (?, ?, ?, ?, ?)`,
          ).run(run.id, stage.stage, input.startedAt, stage.durationMs, stage.status);
        }

        if (input.error) {
          const { errorClass, message } = sanitizeStatsError(input.error);
          db.query(
            `insert into errors
              (run_id, stage, error_class, error_code, sanitized_message, occurred_at)
             values (?, 'transcribe', ?, 'failed', ?, ?)`,
          ).run(run.id, errorClass, message, input.startedAt);
        }
      }
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  } finally {
    db.close();
  }
}
