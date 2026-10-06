import { describe, expect, test } from "bun:test";
import { withVirtualMacHint } from "../../src/engine";
import { KeshaError } from "../../src/engine/events";

// #1419: a hosted macOS runner (VirtualMac2,1, no Neural Engine) fails every CoreML transcription this way.
const bridgeFailure = () =>
  new KeshaError("E_INTERNAL", "FluidAudio sample transcription failed: Swift bridge error: Transcription failed", {
    exitCode: 1,
    origin: "engine",
  });

describe("withVirtualMacHint", () => {
  test("names the missing Neural Engine on a virtualised Mac and keeps the code and message", () => {
    const err = withVirtualMacHint(bridgeFailure(), "darwin", () => true);
    expect(err.code).toBe("E_INTERNAL");
    expect(err.message).toBe(bridgeFailure().message);
    expect(err.exitCode).toBe(1);
    expect(err.hint).toContain("no Apple Neural Engine");
  });

  test("leaves the error alone on a physical Mac", () => {
    expect(withVirtualMacHint(bridgeFailure(), "darwin", () => false).hint).toBeUndefined();
  });

  test("leaves the error alone off macOS", () => {
    expect(withVirtualMacHint(bridgeFailure(), "linux", () => true).hint).toBeUndefined();
  });

  test("leaves other engine failures and existing hints alone", () => {
    const missing = new KeshaError("E_MODEL_MISSING", "ASR model not installed", { hint: "run `kesha install`" });
    expect(withVirtualMacHint(missing, "darwin", () => true).hint).toBe("run `kesha install`");
    const hintedBridge = new KeshaError("E_INTERNAL", "Swift bridge error: Transcription failed", { hint: "keep this hint" });
    expect(withVirtualMacHint(hintedBridge, "darwin", () => true)).toBe(hintedBridge);
    const other = new KeshaError("E_INTERNAL", "kesha-engine transcribe exited with code 1");
    expect(withVirtualMacHint(other, "darwin", () => true).hint).toBeUndefined();
  });
});
