import { describe, expect, it, vi } from "vitest";
import {
  buildRecordingMarkdown,
  buildResultMarkdown,
  buildTranscribingMarkdown,
  formatDuration,
  formatInputFormat,
  recordingStatusLabel,
  recordingStatusTone,
  signalProgress,
  signalStatusLabel,
  signalStatusTone,
} from "../src/lib/recording-view";
import {
  createSignalClassifier,
  parseMeterChunk,
  parseMeterLine,
  percentFromPeak,
  startLiveMicMeter,
} from "../src/lib/signal-meter";
import type { DictationState, SignalLevel } from "../src/lib/dictation-types";
import type { spawn } from "node:child_process";
import { FakeProcess } from "./helpers/fake-process";

describe("signal parsing", () => {
  it("parses meter JSON into a sample without deciding state", () => {
    expect(parseMeterLine('{"rms":0,"peak":0}')).toEqual({
      rms: 0,
      peak: 0,
      percent: 0,
    });
    const loud = parseMeterLine('{"rms":0.035,"peak":0.09}');
    expect(loud).not.toBeNull();
    expect(loud).not.toHaveProperty("state");
    expect(loud!.rms).toBe(0.035);
  });

  it("ignores invalid lines", () => {
    expect(parseMeterLine("nope")).toBeNull();
    expect(parseMeterLine("")).toBeNull();
  });

  it("maps peak to percent on a dB scale, not sqrt", () => {
    // #648's formula yields 17% for a quiet room, not the 0% it predicted.
    expect(percentFromPeak(0)).toBe(0);
    expect(percentFromPeak(0.0085)).toBe(17);
    expect(percentFromPeak(0.0368)).toBe(43);
    expect(percentFromPeak(1)).toBe(100);
  });

  it("handles partial chunks without losing complete samples", () => {
    const first = parseMeterChunk("", '{"rms":0,"peak":0}\n{"rms":');
    expect(first.samples).toHaveLength(1);
    expect(first.remainder).toBe('{"rms":');

    const second = parseMeterChunk(first.remainder, '0.02,"peak":0.1}\n');
    expect(second.samples).toHaveLength(1);
    expect(second.samples[0].rms).toBe(0.02);
    expect(second.remainder).toBe("");
  });
});


describe("recording markdown", () => {
  it("keeps recording markdown calm and moves operational detail to metadata helpers", () => {
    const state: Extract<DictationState, { status: "recording" }> = {
      status: "recording",
      maxSeconds: 300,
      elapsedSeconds: 7,
      silentForMs: 0,
      idle: false,
      mic: { name: "Studio Mic", sampleRate: 48000, channels: 1 },
      signal: { rms: 0.01, peak: 0.05, percent: 24, state: "signal" },
    };

    expect(buildRecordingMarkdown(state)).toBe(
      "# Recording\n\nSpeak now. Kesha records locally from your default microphone.",
    );
    expect(formatInputFormat(state.mic)).toBe("48000 Hz, 1 channel");
    expect(signalProgress(state.signal)).toBe(0.24);
    expect(recordingStatusLabel(state)).toBe("Signal");
    expect(recordingStatusTone(state)).toBe("green");
  });

  it("renders the transcript under a Dictation heading", () => {
    expect(buildResultMarkdown("hello world")).toBe(
      "# Dictation\n\nhello world",
    );
    expect(buildTranscribingMarkdown()).toBe(
      "# Transcribing\n\nProcessing locally with Kesha Voice Kit.",
    );
  });

  it("renders elapsed durations as m:ss and never advertises a max", () => {
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(600)).toBe("10:00");
    expect(formatDuration(0)).toBe("0:00");
  });

  it("flips the recording status tag to amber Idle when idle", () => {
    const state: Extract<DictationState, { status: "recording" }> = {
      status: "recording",
      maxSeconds: 300,
      elapsedSeconds: 42,
      silentForMs: 32_000,
      idle: true,
      mic: { name: "Studio Mic" },
      signal: { rms: 0, peak: 0, percent: 0, state: "listening" },
    };

    expect(buildRecordingMarkdown(state)).toBe(
      "# Recording\n\nNo speech detected — recording will stop soon.",
    );
    expect(recordingStatusLabel(state)).toBe("Idle");
    expect(recordingStatusTone(state)).toBe("orange");
  });

  it("maps meter states to Apple-like metadata labels and tones", () => {
    expect(formatInputFormat({ name: "Default input device" })).toBeNull();
    expect(signalStatusLabel("unavailable")).toBe("Meter Unavailable");
    expect(signalStatusTone("unavailable")).toBe("orange");
    expect(signalStatusLabel("starting")).toBe("Starting");
    expect(signalStatusTone("starting")).toBe("blue");
    expect(signalStatusLabel("listening")).toBe("Listening");
    expect(signalStatusTone("listening")).toBe("secondary");
    expect(signalStatusLabel("signal")).toBe("Signal");
    expect(signalStatusTone("signal")).toBe("green");
  });
});

// Fixtures are the rms percentiles measured on a MacBook Air built-in mic (#648).
describe("createSignalClassifier", () => {
  function feed(rmsValues: number[], startAt = 0, stepMs = 25) {
    let t = startAt;
    const classifier = createSignalClassifier({ now: () => (t += stepMs) });
    return rmsValues.map((rms) => classifier.classify({ rms, peak: rms * 2, percent: 0 }).state);
  }

  it("calls a quiet room listening, not signal", () => {
    const quietRoom = Array(40).fill(0.0021);
    expect(feed(quietRoom).every((s) => s === "listening")).toBe(true);
  });

  it("calls normal speech signal", () => {
    const states = feed([...Array(40).fill(0.0021), ...Array(20).fill(0.035)]);
    expect(states.at(-1)).toBe("signal");
  });

  it("does not call an environmentally noisy room speech", () => {
    // The floor that broke a fixed threshold: 0.027 rms, louder than quiet speech.
    const noisyRoom = Array(60).fill(0.027);
    expect(feed(noisyRoom).slice(20).every((s) => s === "listening")).toBe(true);
  });

  it("still hears louder speech over a noisy floor", () => {
    const states = feed([...Array(40).fill(0.027), ...Array(20).fill(0.12)]);
    expect(states.at(-1)).toBe("signal");
  });

  it("holds through the pauses inside speech instead of chattering", () => {
    const speechWithPauses = [
      ...Array(40).fill(0.002),
      ...Array(10).fill(0.035),
      ...Array(3).fill(0.008),
      ...Array(10).fill(0.035),
    ];
    const states = feed(speechWithPauses);
    const duringSpeech = states.slice(40);
    const flips = duringSpeech.filter((s, i) => i > 0 && s !== duringSpeech[i - 1]).length;
    expect(flips).toBeLessThanOrEqual(1);
  });

  it("treats digital silence as listening even when the floor is zero", () => {
    expect(feed(Array(40).fill(0)).every((s) => s === "listening")).toBe(true);
  });

  it("forgets a floor that has left the window", () => {
    // A loud stretch must not keep the threshold raised once the room goes quiet.
    let t = 0;
    const classifier = createSignalClassifier({ now: () => t });
    for (let i = 0; i < 40; i++) {
      t += 25;
      classifier.classify({ rms: 0.03, peak: 0.06, percent: 0 });
    }
    t += 10_000;
    for (let i = 0; i < 40; i++) {
      t += 25;
      classifier.classify({ rms: 0.002, peak: 0.004, percent: 0 });
    }
    t += 25;
    expect(classifier.classify({ rms: 0.02, peak: 0.04, percent: 0 }).state).toBe("signal");
  });
});

describe("startLiveMicMeter", () => {
  function startWithFakeProcess() {
    const proc = new FakeProcess();
    const signals: SignalLevel[] = [];
    const stop = startLiveMicMeter((signal) => signals.push(signal), {
      spawn: vi.fn(() => proc) as unknown as typeof spawn,
      kill: vi.fn(),
      setTimeout: vi.fn(() => ({
        unref: vi.fn(),
      })) as unknown as typeof setTimeout,
    });
    return { proc, signals, stop };
  }

  // Needed because the first sample is its own floor and so can never be speech.
  const warmUp = `${'{"rms":0.002,"peak":0.004}\n'.repeat(10)}`;

  it("reports unavailable when the meter dies after delivering samples", () => {
    const { proc, signals } = startWithFakeProcess();

    proc.emitStdout(`${warmUp}{"rms":0.05,"peak":0.1}\n`);
    proc.emit("exit", 1, null);

    expect(signals.at(-2)?.state).toBe("signal");
    expect(signals.at(-1)?.state).toBe("unavailable");
  });

  it("stays quiet when the session stops the meter itself", () => {
    const { proc, signals, stop } = startWithFakeProcess();

    proc.emitStdout(`${warmUp}{"rms":0.05,"peak":0.1}\n`);
    stop();
    proc.emit("exit", 0, "SIGTERM");

    expect(signals.map((s) => s.state)).not.toContain("unavailable");
    expect(signals.at(-1)?.state).toBe("signal");
  });

  it("cannot call the first sample speech, since it is its own floor", () => {
    const { proc, signals } = startWithFakeProcess();

    proc.emitStdout('{"rms":0.05,"peak":0.1}\n');

    expect(signals.at(-1)?.state).toBe("listening");
  });
});
