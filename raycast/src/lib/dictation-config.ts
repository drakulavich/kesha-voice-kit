export const DEFAULT_MAX_SECONDS = 300;
export const MAX_ALLOWED_SECONDS = 3600;
export const METER_INTERVAL_MS = 500;
// -80 dBFS: a test for digital silence in a recorded file, never for speech (#648).
export const SILENCE_PEAK_THRESHOLD = 0.0001;

// No constant works: a noisy room's floor is louder than quiet speech (#648).
export const FLOOR_WINDOW_MS = 3_000;
export const FLOOR_PERCENTILE = 0.1;
export const SIGNAL_ENTER_RATIO = 3;
export const SIGNAL_LEAVE_RATIO = 1.8;
// rms reads exactly 0 sometimes, so a purely relative rule would call dither speech.
export const SIGNAL_ENTER_MIN_RMS = 0.01;
export const SIGNAL_LEAVE_MIN_RMS = 0.006;
export const IDLE_WARN_MS = 30_000;
export const IDLE_STOP_GRACE_MS = 15_000;
export const NO_SIGNAL_TIMEOUT_MS = 8_000;
export const PROBE_TIMEOUT_MS = 5_000;
export const TRANSCRIBE_TIMEOUT_MS = 60_000;
export const TRANSCRIBE_TIMEOUT_SECONDS = TRANSCRIBE_TIMEOUT_MS / 1000;

export function parseMaxSeconds(value: string | undefined): number {
  const raw = value?.trim() || String(DEFAULT_MAX_SECONDS);
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_ALLOWED_SECONDS
  ) {
    throw new Error(
      `Max recording seconds must be an integer between 1 and ${MAX_ALLOWED_SECONDS}.`,
    );
  }
  return parsed;
}
