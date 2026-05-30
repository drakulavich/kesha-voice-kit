import { describe, expect, test } from "bun:test";
import { SayError } from "../synth";

describe("SayError carries a taxonomy code", () => {
  test("pre-check throws carry text codes", () => {
    const e = new SayError("text is empty", 2, "", "E_TEXT_EMPTY");
    expect(e.code).toBe("E_TEXT_EMPTY");
    expect(e.exitCode).toBe(2);
  });
  test("defaults to E_INTERNAL when unspecified", () => {
    const e = new SayError("boom", 4, "");
    expect(e.code).toBe("E_INTERNAL");
  });
});
