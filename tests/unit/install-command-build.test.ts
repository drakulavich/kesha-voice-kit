import { describe, expect, test } from "bun:test";
import { selectBackend } from "../../src/cli/install";
import { buildInstallCommand } from "../../src/install-plan";

describe("selectBackend", () => {
  test("maps each flag to its backend", () => {
    expect(selectBackend(true, false)).toEqual({ ok: true, backend: "coreml" });
    expect(selectBackend(false, true)).toEqual({ ok: true, backend: "onnx" });
  });

  test("neither flag leaves the backend to platform auto-detection", () => {
    expect(selectBackend(false, false)).toEqual({ ok: true, backend: undefined });
  });

  test("both flags are rejected", () => {
    const result = selectBackend(true, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Choose only one backend: "--coreml" or "--onnx".');
  });
});

describe("buildInstallCommand", () => {
  test("a bare plan reproduces the plain install command", () => {
    expect(buildInstallCommand({}, [])).toBe("kesha install");
  });

  test("flags appear in the documented order", () => {
    expect(
      buildInstallCommand({ noCache: true, backend: "coreml", vad: true, diarize: true }, ["en", "ru"]),
    ).toBe("kesha install --no-cache --coreml --tts en ru --vad --diarize");
  });

  test("the onnx backend renders its own flag", () => {
    expect(buildInstallCommand({ backend: "onnx" }, [])).toBe("kesha install --onnx");
  });

  // #738: reproducing a different version than the plan previewed is worse than no Run: line.
  test("an engine override leads the reproduced command", () => {
    expect(
      buildInstallCommand({ engineVersion: "1.24.8-alpha.1", noCache: true }, ["en"]),
    ).toBe("kesha install --engine-version 1.24.8-alpha.1 --no-cache --tts en");
  });

  test("languages are only emitted with --tts", () => {
    expect(buildInstallCommand({}, ["es"])).toBe("kesha install --tts es");
    expect(buildInstallCommand({ vad: true }, [])).toBe("kesha install --vad");
  });
});
