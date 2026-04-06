import { describe, test, expect } from "bun:test";
import { greedyDecode, type DecoderSession } from "../decoder";

function mockSession(responses: Array<{ tokenLogits: number[]; durationLogits: number[] }>): DecoderSession {
  let callIndex = 0;
  return {
    async decode(_encoderFrame, _targets, _targetLength, _state1, _state2) {
      const resp = responses[Math.min(callIndex++, responses.length - 1)];
      const output = new Float32Array([...resp.tokenLogits, ...resp.durationLogits]);
      const state1 = new Float32Array(1);
      const state2 = new Float32Array(1);
      return { output, state1, state2 };
    },
    vocabSize: responses[0]?.tokenLogits.length ?? 4,
    blankId: (responses[0]?.tokenLogits.length ?? 4) - 1,
    stateDims: { layers: 1, hidden: 1 },
  };
}

describe("decoder", () => {
  test("emits non-blank tokens", async () => {
    const session = mockSession([
      { tokenLogits: [10, 0, 0, -10], durationLogits: [10, 0] },
      { tokenLogits: [0, 10, 0, -10], durationLogits: [10, 0] },
      { tokenLogits: [0, 0, 0, 10], durationLogits: [10, 0] },
    ]);
    const tokens = await greedyDecode(session, 3);
    expect(tokens).toEqual([0, 1]);
  });

  test("respects duration skipping", async () => {
    const session = mockSession([
      { tokenLogits: [10, 0, 0, -10], durationLogits: [0, 0, 10] },
      { tokenLogits: [0, 10, 0, -10], durationLogits: [10, 0, 0] },
      { tokenLogits: [0, 0, 0, 10], durationLogits: [10, 0, 0] },
    ]);
    const tokens = await greedyDecode(session, 5);
    expect(tokens).toEqual([0, 1]);
  });

  test("handles max_tokens_per_step limit", async () => {
    const session = mockSession([
      { tokenLogits: [10, 0, 0, -10], durationLogits: [10, 0] },
    ]);
    const tokens = await greedyDecode(session, 2);
    expect(tokens.length).toBeLessThanOrEqual(20);
    expect(tokens.length).toBeGreaterThan(0);
  });

  test("returns empty for zero-length encoder output", async () => {
    const session = mockSession([
      { tokenLogits: [0, 0, 0, 10], durationLogits: [10, 0] },
    ]);
    const tokens = await greedyDecode(session, 0);
    expect(tokens).toEqual([]);
  });
});
