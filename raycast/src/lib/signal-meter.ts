import { spawn as defaultSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  FLOOR_PERCENTILE,
  FLOOR_WINDOW_MS,
  SIGNAL_ENTER_MIN_RMS,
  SIGNAL_ENTER_RATIO,
  SIGNAL_LEAVE_MIN_RMS,
  SIGNAL_LEAVE_RATIO,
} from "./dictation-config";
import type { SignalLevel, SignalState } from "./dictation-types";
import { emptySignal } from "./recording-view";
import { numberValue } from "./mic-info";
import { killProcessGroup } from "./process-tasks";

export const SWIFT_MIC_METER_SCRIPT = `
import AVFoundation
import Foundation

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)

if format.channelCount == 0 {
  FileHandle.standardError.write(Data("No input channels\\n".utf8))
  exit(1)
}

input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
  guard let channels = buffer.floatChannelData else { return }
  let channelCount = Int(buffer.format.channelCount)
  let frameCount = Int(buffer.frameLength)
  if channelCount == 0 || frameCount == 0 { return }

  var sum: Float = 0
  var peak: Float = 0
  var count = 0

  for channel in 0..<channelCount {
    let samples = channels[channel]
    for frame in 0..<frameCount {
      let sample = samples[frame]
      let absolute = abs(sample)
      sum += sample * sample
      peak = max(peak, absolute)
      count += 1
    }
  }

  let rms = sqrt(sum / Float(max(count, 1)))
  print("{\\"rms\\":\\(rms),\\"peak\\":\\(peak)}")
  fflush(stdout)
}

do {
  try engine.start()
  RunLoop.current.run()
} catch {
  FileHandle.standardError.write(Data("\\(error)\\n".utf8))
  exit(1)
}
`;

interface LiveMicMeterDeps {
  spawn?: typeof defaultSpawn;
  kill?: (proc: ChildProcess, signal: NodeJS.Signals) => void;
  setTimeout?: typeof setTimeout;
  now?: () => number;
}

export interface MeterSample {
  rms: number;
  peak: number;
  percent: number;
}

// dBFS, not sqrt(peak) — the square root rendered a silent room at ~30% (#648).
export function percentFromPeak(peak: number): number {
  if (peak <= 0) return 0;
  const dbfs = 20 * Math.log10(peak);
  return Math.max(0, Math.min(100, Math.round(((dbfs + 50) / 50) * 100)));
}

export function parseMeterLine(line: string): MeterSample | null {
  try {
    const parsed = JSON.parse(line) as Partial<MeterSample>;
    const rms = numberValue(parsed.rms) ?? 0;
    const peak = numberValue(parsed.peak) ?? 0;
    return { rms, peak, percent: percentFromPeak(peak) };
  } catch {
    return null;
  }
}

export function parseMeterChunk(
  previousRemainder: string,
  chunk: string,
): { samples: MeterSample[]; remainder: string } {
  const lines = `${previousRemainder}${chunk}`.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  return {
    remainder,
    samples: lines.flatMap((line) => {
      const sample = parseMeterLine(line);
      return sample ? [sample] : [];
    }),
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[index];
}

/**
 * Classifies samples as speech relative to a rolling estimate of the room floor.
 *
 * Hysteresis is not decoration: without the gap between the enter and leave
 * thresholds the state chatters at the boundary, and every flip to "signal"
 * resets the idle timer (#648).
 */
export function createSignalClassifier(deps: { now?: () => number } = {}): {
  classify: (sample: MeterSample) => SignalLevel;
} {
  const now = deps.now ?? Date.now;
  const window: Array<{ at: number; rms: number }> = [];
  let state: SignalState = "listening";

  return {
    classify: (sample) => {
      const at = now();
      window.push({ at, rms: sample.rms });
      while (window.length > 0 && at - window[0].at > FLOOR_WINDOW_MS) {
        window.shift();
      }
      const floor = percentile(
        window.map((s) => s.rms).sort((a, b) => a - b),
        FLOOR_PERCENTILE,
      );
      const enter = Math.max(SIGNAL_ENTER_MIN_RMS, floor * SIGNAL_ENTER_RATIO);
      const leave = Math.max(SIGNAL_LEAVE_MIN_RMS, floor * SIGNAL_LEAVE_RATIO);
      state =
        state === "signal"
          ? sample.rms >= leave
            ? "signal"
            : "listening"
          : sample.rms >= enter
            ? "signal"
            : "listening";
      return { ...sample, state };
    },
  };
}

export function startLiveMicMeter(
  onSignal: (signal: SignalLevel) => void,
  deps: LiveMicMeterDeps = {},
): () => void {
  const spawn = deps.spawn ?? defaultSpawn;
  const kill = deps.kill ?? killProcessGroup;
  const schedule = deps.setTimeout ?? setTimeout;
  const proc = spawn("/usr/bin/swift", ["-e", SWIFT_MIC_METER_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stopped = false;
  let stdout = "";
  const classifier = createSignalClassifier({ now: deps.now });

  proc.stdout?.on("data", (chunk: Buffer) => {
    const parsed = parseMeterChunk(stdout, chunk.toString("utf8"));
    stdout = parsed.remainder;
    for (const sample of parsed.samples) {
      if (!stopped) onSignal(classifier.classify(sample));
    }
  });

  proc.once("error", () => {
    if (!stopped) onSignal(emptySignal("unavailable"));
  });
  // `stopped` already covers our own teardown, so any other exit means the
  // meter died — report it even after samples, or the silence auto-stop would
  // keep waiting on a state that can no longer change.
  proc.once("exit", () => {
    if (!stopped) onSignal(emptySignal("unavailable"));
  });

  return () => {
    stopped = true;
    kill(proc, "SIGTERM");
    schedule(() => {
      if (proc.exitCode == null) kill(proc, "SIGKILL");
    }, 1000).unref?.();
  };
}
