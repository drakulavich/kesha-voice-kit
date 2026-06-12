import { describe, expect, test } from "bun:test";
import { errorMessage } from "../../src/error-utils";

describe("errorMessage", () => {
  test("returns .message for Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  test("stringifies non-Error throwables", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
