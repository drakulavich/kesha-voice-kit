/**
 * Error-code taxonomy bridge. The engine is the source of truth for engine
 * codes (see `kesha-engine --error-codes-json`); these are the codes that
 * originate in TS, before/around the engine. See
 * `docs/superpowers/specs/2026-05-30-structured-error-taxonomy-design.md`.
 */

/** Matches the engine's `error [CODE]:` line; CODE charset is constrained. */
const ENGINE_CODE_RE = /^error \[([A-Z0-9_]+)\]:/m;

/** Extract the engine error code from captured stderr, if present. */
export function extractEngineErrorCode(stderr: string): string | undefined {
  const m = stderr.match(ENGINE_CODE_RE);
  return m ? m[1] : undefined;
}

/** Codes that originate in TS (engine never ran, or isn't the failing party). */
export const TS_NATIVE_CODES = {
  INPUT_NOT_FOUND: "E_INPUT_NOT_FOUND",
  ENGINE_SPAWN: "E_ENGINE_SPAWN",
  INVALID_ARG: "E_INVALID_ARG",
  INTERNAL: "E_INTERNAL",
} as const;

export type TsNativeCode = (typeof TS_NATIVE_CODES)[keyof typeof TS_NATIVE_CODES];

/**
 * Engine-owned codes the TS CLI also references by name (e.g. as a fallback
 * when the engine died without printing an `error [CODE]:` line). These are NOT
 * TS-native — the engine is the source of truth — so they stay out of
 * {@link KNOWN_TS_CODES} and the drift test. Named here to avoid bare string
 * literals scattered through the CLI.
 */
export const ENGINE_CODES = {
  TRANSCRIBE_FAILED: "E_TRANSCRIBE_FAILED",
} as const;

/** The full set of TS-native codes, for the drift test. */
export const KNOWN_TS_CODES: ReadonlySet<string> = new Set(Object.values(TS_NATIVE_CODES));

/** Resolve a code from engine stderr, falling back to E_INTERNAL. */
export function engineErrorCode(stderr: string): string {
  return extractEngineErrorCode(stderr) ?? TS_NATIVE_CODES.INTERNAL;
}
