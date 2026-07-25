import { createDiagnosticLogSession } from "../diagnostic-log";
import type {
  DiagnosticLogFields,
  DiagnosticLogSession,
  DiagnosticSessionStatus,
} from "../diagnostic-log";
import { errorMessage } from "../error-utils";
import { log } from "../log";
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

/** Runs one CLI command's body between `command.start` / `command.finish`, closing both recorders exactly once; `body` reports failure by returning a {@link CommandOutcome}, never by exiting. */
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
    closeSessionQuietly(session, command, { status: "failed", itemCount: 0 });
    throw err;
  }

  // A flush error must not displace a failure the command already has to report (Greptile P1/P2 on #607).
  if (outcome.status === "failed") {
    closeSessionQuietly(session, command, outcome);
  } else {
    closeSession(session, command, outcome);
  }
  return outcome;
}

function closeSessionQuietly(
  session: CommandSession,
  command: StatsCommandName,
  outcome: CommandOutcome,
): void {
  try {
    closeSession(session, command, outcome);
  } catch (err) {
    log.debug(`command session cleanup failed: ${errorMessage(err)}`);
  }
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
