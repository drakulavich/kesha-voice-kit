import { describe, expect, test } from "bun:test";
import { runCommandSession, type CommandSessionFactories } from "../../src/cli/command-session";
import type { DiagnosticLogFields, DiagnosticLogSession, DiagnosticSessionStatus } from "../../src/diagnostic-log";
import type { StatsRecorder, StatsRunStatus } from "../../src/stats";

type LoggedEvent = { event: string; fields: DiagnosticLogFields };

function fakeSession(): {
  factories: CommandSessionFactories;
  events: LoggedEvent[];
  finishes: DiagnosticSessionStatus[];
  statsFinishes: Array<{ status: StatsRunStatus; itemCount: number | undefined }>;
  statsCommands: string[];
} {
  const events: LoggedEvent[] = [];
  const finishes: DiagnosticSessionStatus[] = [];
  const statsFinishes: Array<{ status: StatsRunStatus; itemCount: number | undefined }> = [];
  const statsCommands: string[] = [];

  const diagnosticLog: DiagnosticLogSession = {
    event(event, fields = {}) {
      events.push({ event, fields });
      return true;
    },
    finish(status) {
      finishes.push(status);
      return true;
    },
  };

  const stats: StatsRecorder = {
    enabled: false,
    recordArtifact() {},
    async timeStage(_stage, fn) {
      return fn();
    },
    recordError() {},
    finish(status, itemCount) {
      statsFinishes.push({ status, itemCount });
    },
  };

  return {
    factories: {
      createStats: (command) => {
        statsCommands.push(command);
        return stats;
      },
      createDiagnosticLog: () => diagnosticLog,
    },
    events,
    finishes,
    statsFinishes,
    statsCommands,
  };
}

describe("runCommandSession", () => {
  test("emits command.start with the command name and caller fields", async () => {
    const f = fakeSession();
    await runCommandSession(
      "transcribe",
      { itemCount: 2, outputFormat: "json" },
      async () => ({ status: "success", itemCount: 2 }),
      f.factories,
    );

    expect(f.statsCommands).toEqual(["transcribe"]);
    expect(f.events[0]).toEqual({
      event: "command.start",
      fields: { command: "transcribe", itemCount: 2, outputFormat: "json" },
    });
  });

  test("emits command.finish with status plus the outcome's finish fields", async () => {
    const f = fakeSession();
    await runCommandSession(
      "say",
      {},
      async () => ({ status: "success", itemCount: 1, finishFields: { durationMs: 42, hasOut: true } }),
      f.factories,
    );

    expect(f.events[1]).toEqual({
      event: "command.finish",
      fields: { command: "say", status: "success", durationMs: 42, hasOut: true },
    });
  });

  test("closes both recorders with the outcome status", async () => {
    const f = fakeSession();
    await runCommandSession(
      "transcribe",
      {},
      async () => ({ status: "failed", itemCount: 3 }),
      f.factories,
    );

    expect(f.statsFinishes).toEqual([{ status: "failed", itemCount: 3 }]);
    expect(f.finishes).toEqual(["failed"]);
  });

  test("returns the body's outcome to the caller", async () => {
    const f = fakeSession();
    const outcome = await runCommandSession(
      "say",
      {},
      async () => ({ status: "failed", itemCount: 1, exitCode: 5 }),
      f.factories,
    );

    expect(outcome.exitCode).toBe(5);
    expect(outcome.status).toBe("failed");
  });

  test("hands the body a live session so it can record stages and events", async () => {
    const f = fakeSession();
    await runCommandSession(
      "say",
      {},
      async (session) => {
        session.diagnosticLog.event("engine.exit", { status: "success" });
        return { status: "success", itemCount: 1 };
      },
      f.factories,
    );

    expect(f.events.map((e) => e.event)).toEqual(["command.start", "engine.exit", "command.finish"]);
  });

  test("a failing diagnostic flush does not mask the command error (Greptile P2 on #607)", async () => {
    const f = fakeSession();
    const factories: CommandSessionFactories = {
      createStats: f.factories.createStats,
      createDiagnosticLog: () => {
        const session = f.factories.createDiagnosticLog();
        return {
          event: session.event,
          finish: () => {
            throw new Error("disk full");
          },
        };
      },
    };

    await expect(
      runCommandSession("say", {}, async () => {
        throw new Error("engine crashed");
      }, factories),
    ).rejects.toThrow("engine crashed");
  });

  test("a throwing body still closes the session as failed, then rethrows", async () => {
    const f = fakeSession();
    const boom = new Error("boom");

    await expect(
      runCommandSession("transcribe", {}, async () => {
        throw boom;
      }, f.factories),
    ).rejects.toThrow("boom");

    expect(f.events[1]?.event).toBe("command.finish");
    expect(f.events[1]?.fields.status).toBe("failed");
    expect(f.statsFinishes).toEqual([{ status: "failed", itemCount: 0 }]);
    expect(f.finishes).toEqual(["failed"]);
  });
});
