export const DEFAULT_MAX_SECONDS = 300;
export const MAX_ALLOWED_SECONDS = 3600;
export const METER_INTERVAL_MS = 500;
// -80 dBFS: a test for digital silence in a recorded file, never for speech (#648).
export const SILENCE_PEAK_THRESHOLD = 0.0001;

// Sits between a quiet room's rms p90 (0.0075) and speech p50 (0.0097) (#648).
export const SPEECH_RMS_THRESHOLD = 0.01;
export const IDLE_WARN_MS = 30_000;
export const IDLE_STOP_GRACE_MS = 15_000;
export const NO_SIGNAL_TIMEOUT_MS = 8_000;
export const PROBE_TIMEOUT_MS = 5_000;

// Transcription timeout scales with recording length so a long recording cannot
// outrun a fixed cap after the audio is already captured (#944): a fixed 60 s
// was five times shorter than the default 300 s recording cap.
//
// Derivation — ONNX-CPU is the slowest supported backend. BENCHMARK.md (M2)
// shows warm ONNX transcribing 3-10 s clips in 1.7-2.1 s (real-time factor
// ~0.3-0.7) and paying a one-time ~7 s model warmup on the first, cold file.
// The 60 s floor absorbs that cold-start warmup plus a short note, so a 30 s
// clip keeps a tight bound. The 2000 ms/s allowance is 2x real-time — roughly
// 3x the worst observed warm RTF — leaving margin for a cold engine, a CPU
// slower than the M2, and denser-than-benchmark speech.
export const TRANSCRIBE_TIMEOUT_FLOOR_MS = 60_000;
export const TRANSCRIBE_TIMEOUT_PER_SECOND_MS = 2_000;

export function transcribeTimeoutMs(recordingSeconds: number): number {
  const seconds =
    Number.isFinite(recordingSeconds) && recordingSeconds > 0
      ? Math.ceil(recordingSeconds)
      : 0;
  return (
    TRANSCRIBE_TIMEOUT_FLOOR_MS + seconds * TRANSCRIBE_TIMEOUT_PER_SECOND_MS
  );
}

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
