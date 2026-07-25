import { createDiagnosticLogSession } from "../diagnostic-log";
import type {
  DiagnosticLogFields,
  DiagnosticLogSession,
  DiagnosticSessionStatus,
} from "../diagnostic-log";
import { createStatsRecorder } from "../stats";
import type { StatsCommandName, StatsRecorder } from "../stats";

export interface CommandSession {
  readonly stats: StatsRecorder;
  readonly diagnosticLog: DiagnosticLogSession;
}

export interface CommandOutcome {
  status: DiagnosticSessionStatus;
  itemCount: number;
  /** Merged into the `command.finish` event alongside `command` and `status`. */
  finishFields?: DiagnosticLogFields;
  /** Exit code the caller should terminate with; omitted means "don't exit". */
  exitCode?: number;
}

export interface CommandSessionFactories {
  createStats: (command: StatsCommandName) => StatsRecorder;
  createDiagnosticLog: () => DiagnosticLogSession;
}

const defaultFactories: CommandSessionFactories = {
  createStats: createStatsRecorder,
  createDiagnosticLog: createDiagnosticLogSession,
};

/**
 * Owns the stats + diagnostic-log lifecycle for one CLI command: opens both
 * recorders, brackets `body` with `command.start` / `command.finish`, and closes
 * them exactly once. `body` reports what happened by returning a
 * {@link CommandOutcome} instead of calling `process.exit` itself.
 */
export async function runCommandSession(
  command: StatsCommandName,
  startFields: DiagnosticLogFields,
  body: (session: CommandSession) => Promise<CommandOutcome>,
  factories: CommandSessionFactories = defaultFactories,
): Promise<CommandOutcome> {
  const session: CommandSession = {
    stats: factories.createStats(command),
    diagnosticLog: factories.createDiagnosticLog(),
  };
  session.diagnosticLog.event("command.start", { command, ...startFields });

  let outcome: CommandOutcome;
  try {
    outcome = await body(session);
  } catch (err) {
    closeSession(session, command, { status: "failed", itemCount: 0 });
    throw err;
  }

  closeSession(session, command, outcome);
  return outcome;
}

function closeSession(session: CommandSession, command: StatsCommandName, outcome: CommandOutcome): void {
  session.diagnosticLog.event("command.finish", {
    command,
    status: outcome.status,
    ...outcome.finishFields,
  });
  session.stats.finish(outcome.status, outcome.itemCount);
  session.diagnosticLog.finish(outcome.status);
}
