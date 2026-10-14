import { afterEach, describe, expect, test } from "bun:test";
import { installHint } from "../../src/install-hint";

const streams = [process.stdin, process.stdout, process.stderr] as const;
const original = streams.map((s) => s.isTTY);

function setTTY(stdin: boolean, stdout: boolean, stderr: boolean): void {
  [stdin, stdout, stderr].forEach((value, i) =>
    Object.defineProperty(streams[i], "isTTY", { value, configurable: true }),
  );
}

afterEach(() => {
  streams.forEach((s, i) => Object.defineProperty(s, "isTTY", { value: original[i], configurable: true }));
});

describe("installHint", () => {
  test("suggests kesha init in a full terminal", () => {
    setTTY(true, true, true);
    expect(installHint("--tts")).toBe("kesha init --tts");
  });

  test("suggests kesha install when stdin or stdout is piped, where init refuses (#1380)", () => {
    setTTY(false, true, true);
    expect(installHint("--tts")).toBe("kesha install --tts");
    setTTY(true, false, true);
    expect(installHint()).toBe("kesha install");
  });

  test("suggests kesha install when stderr is not a terminal", () => {
    setTTY(true, true, false);
    expect(installHint()).toBe("kesha install");
  });
});
