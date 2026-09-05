import { log } from "../log";

export interface ProgressEvent {
  kind: "progress";
  phase?: string;
  message: string;
}
export interface WarnEvent {
  kind: "warn";
  code: string;
  message: string;
}
export interface ErrorEvent {
  kind: "error";
  code: string;
  message: string;
  hint?: string;
}
export interface DebugEvent {
  kind: "debug";
  t_ms: number;
  event?: string;
  message: string;
  fields?: unknown;
}
export type EngineEvent = ProgressEvent | WarnEvent | ErrorEvent | DebugEvent;

export type ParsedLine = { ok: true; event: EngineEvent } | { ok: false; raw: string };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One stderr line of the protocol 4 event stream; anything else is reported as `raw`. */
export function parseEventLine(line: string): ParsedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, raw: line };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, raw: line };
  const o = parsed as Record<string, unknown>;
  if (typeof o.message !== "string") return { ok: false, raw: line };
  const message = o.message;
  switch (o.kind) {
    case "progress": {
      const phase = optionalString(o.phase);
      return { ok: true, event: phase === undefined ? { kind: "progress", message } : { kind: "progress", phase, message } };
    }
    case "warn":
      if (typeof o.code !== "string") return { ok: false, raw: line };
      return { ok: true, event: { kind: "warn", code: o.code, message } };
    case "error": {
      if (typeof o.code !== "string") return { ok: false, raw: line };
      const hint = optionalString(o.hint);
      return { ok: true, event: hint === undefined ? { kind: "error", code: o.code, message } : { kind: "error", code: o.code, message, hint } };
    }
    case "debug": {
      if (typeof o.t_ms !== "number") return { ok: false, raw: line };
      const event: DebugEvent = { kind: "debug", t_ms: o.t_ms, message };
      const name = optionalString(o.event);
      if (name !== undefined) event.event = name;
      if (o.fields !== undefined && o.fields !== null) event.fields = o.fields;
      return { ok: true, event };
    }
    default:
      return { ok: false, raw: line };
  }
}

/** The one place the human `error [CODE]: message` line is written. */
export function renderError(e: { code: string; message: string; hint?: string }): string {
  const line = `error [${e.code}]: ${e.message}`;
  return e.hint ? `${line}\n  hint: ${e.hint}` : line;
}

export function renderEvent(event: EngineEvent): string {
  switch (event.kind) {
    case "progress":
      return event.phase ? `${event.phase}: ${event.message}` : event.message;
    case "warn":
      return event.message;
    case "error":
      return renderError(event);
    case "debug":
      return `[debug/engine +${event.t_ms}ms] ${event.message}`;
  }
}

export class KeshaError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly exitCode?: number;
  readonly stderr?: string;

  constructor(code: string, message: string, extra: { hint?: string; exitCode?: number; stderr?: string } = {}) {
    super(message);
    this.name = "KeshaError";
    this.code = code;
    if (extra.hint !== undefined) this.hint = extra.hint;
    if (extra.exitCode !== undefined) this.exitCode = extra.exitCode;
    if (extra.stderr !== undefined) this.stderr = extra.stderr;
  }

  /** The engine's transcript already carries the rendered error line; without one, render this error. */
  render(): string {
    return this.stderr?.trim() || renderError(this);
  }
}

let debugSink: ((event: DebugEvent) => void) | null = null;

/** The CLI installs its diagnostic-log session here for the life of a command; `null` falls back to `log.debug`. */
export function setEngineDebugSink(sink: ((event: DebugEvent) => void) | null): void {
  debugSink = sink;
}

export interface EventSinks {
  onProgress?: (line: string) => void;
}

export interface StderrOutcome {
  /** Everything not delivered to a sink, rendered, one line each with a trailing newline. */
  stderr: string;
  error: ErrorEvent | null;
  /** Lines that were not events; the caller turns a non-empty list into `E_INTERNAL`. */
  invalid: string[];
}

/** Reads a protocol 4 stderr stream to EOF, accepting `\r\n`, delivering progress live. */
export async function readEvents(
  stream: ReadableStream<Uint8Array>,
  sinks: EventSinks = {},
): Promise<StderrOutcome> {
  const outcome: StderrOutcome = { stderr: "", error: null, invalid: [] };
  const take = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) {
      // Mid-transcript, a blank line is prose to preserve; a leading/trailing one is a stray artifact.
      if (outcome.stderr.length > 0) outcome.stderr += "\n";
      return;
    }
    const parsed = parseEventLine(line);
    if (!parsed.ok) {
      outcome.invalid.push(line);
      outcome.stderr += `${line}\n`;
      return;
    }
    const event = parsed.event;
    if (event.kind === "debug") {
      if (debugSink) debugSink(event);
      else log.debug(renderEvent(event));
      return;
    }
    if (event.kind === "error") outcome.error = event;
    if (event.kind === "progress" && sinks.onProgress) {
      sinks.onProgress(renderEvent(event));
      return;
    }
    outcome.stderr += `${renderEvent(event)}\n`;
  };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      take(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) take(pending);
  return outcome;
}
