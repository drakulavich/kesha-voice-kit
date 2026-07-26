import { describe, expect, it, vi } from "vitest";
import { startRecordingMonitor } from "../src/lib/recording-monitor";
import type { RecordingMonitorDeps } from "../src/lib/recording-monitor";
import type { RecordingPatch, SignalLevel } from "../src/lib/dictation-types";
import { emptySignal } from "../src/lib/recording-view";
import { METER_INTERVAL_MS } from "../src/lib/dictation-config";

function createHarness(overrides: Partial<RecordingMonitorDeps> = {}) {
  let clock = 0;
  let tick: (() => void) | null = null;
  let onSignal: ((signal: SignalLevel) => void) | null = null;
  const patches: RecordingPatch[] = [];
  const timerToken = {} as ReturnType<typeof setInterval>;
  const clearIntervalSpy = vi.fn();
  const stopMeter = vi.fn();
  const micInfo = deferred<RecordingPatch["mic"]>();

  const schedule = vi.fn((fn: () => void) => {
    tick = fn;
    return timerToken;
  }) as unknown as typeof setInterval;

  const deps: RecordingMonitorDeps = {
    now: () => clock,
    setInterval: schedule,
    clearInterval: clearIntervalSpy as unknown as typeof clearInterval,
    resolveDefaultMicInfo: () => micInfo.promise,
    startLiveMicMeter: (cb) => {
      onSignal = cb;
      return stopMeter;
    },
    ...overrides,
  };

  const stop = startRecordingMonitor((patch) => patches.push(patch), deps);
  return {
    patches,
    stop,
    stopMeter,
    clearIntervalSpy,
    timerToken,
    micInfo,
    schedule,
    setClock: (value: number) => {
      clock = value;
    },
    fireTick: () => tick?.(),
    emitSignal: (signal: SignalLevel) => onSignal?.(signal),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("startRecordingMonitor", () => {
  it("emits an immediate elapsed tick and schedules the meter interval", () => {
    const harness = createHarness();
    expect(harness.patches).toEqual([{ elapsedSeconds: 0 }]);
    expect(harness.schedule).toHaveBeenCalledWith(
      expect.any(Function),
      METER_INTERVAL_MS,
    );
  });

  it("reports elapsed whole seconds from its start time", () => {
    const harness = createHarness();
    harness.setClock(2_400);
    harness.fireTick();
    expect(harness.patches.at(-1)).toEqual({ elapsedSeconds: 2 });
  });

  it("forwards mic info and meter signals as patches", async () => {
    const harness = createHarness();
    harness.emitSignal(emptySignal("unavailable"));
    harness.micInfo.resolve({ name: "Studio Mic", sampleRate: 48000 });
    await Promise.resolve();

    expect(harness.patches).toContainEqual({
      signal: emptySignal("unavailable"),
    });
    expect(harness.patches).toContainEqual({
      mic: { name: "Studio Mic", sampleRate: 48000 },
    });
  });

  it("stops the timer and meter, then drops late updates", async () => {
    const harness = createHarness();
    harness.stop();

    expect(harness.clearIntervalSpy).toHaveBeenCalledWith(harness.timerToken);
    expect(harness.stopMeter).toHaveBeenCalledTimes(1);

    const seen = harness.patches.length;
    harness.fireTick();
    harness.emitSignal(emptySignal("unavailable"));
    harness.micInfo.resolve({ name: "Late Mic" });
    await Promise.resolve();
    expect(harness.patches).toHaveLength(seen);
  });
});
