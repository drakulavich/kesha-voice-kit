import { describe, expect, test } from "bun:test";
import { npmDistTag } from "../../.github/scripts/npm-dist-tag.mjs";

describe("npmDistTag", () => {
  test("a stable version publishes to latest", () => {
    expect(npmDistTag("1.27.0")).toBe("latest");
  });

  test("a prerelease publishes to the channel it names", () => {
    expect(npmDistTag("1.27.0-alpha.1")).toBe("alpha");
    expect(npmDistTag("1.27.0-beta.2")).toBe("beta");
  });

  test("a channel it has never heard of still resolves", () => {
    expect(npmDistTag("1.27.0-rc.1")).toBe("rc");
    expect(npmDistTag("1.27.0-next.1")).toBe("next");
  });

  test("alpha and beta do not share a dist-tag", () => {
    expect(npmDistTag("1.27.0-alpha.1")).not.toBe(npmDistTag("1.27.0-beta.1"));
  });

  test("a prerelease can never reach the latest dist-tag", () => {
    expect(() => npmDistTag("1.27.0-latest.1")).toThrow(/refusing/);
  });

  test("rejects a prerelease identifier that is not a usable channel name", () => {
    for (const version of ["1.27.0-1", "1.27.0-Alpha.1"]) {
      expect(() => npmDistTag(version)).toThrow(/not a usable channel name/);
    }
  });

  // The string-slicing resolver read `not-a-version` as the channel `a-version`.
  test("rejects a string that is not a version rather than reading a channel out of it", () => {
    for (const version of ["1.27.0-.1", "1.27.0-", "not-a-version", "1.27"]) {
      expect(() => npmDistTag(version)).toThrow(/not a valid SemVer 2\.0 version/);
    }
  });

  test("rejects a missing version rather than guessing", () => {
    expect(() => npmDistTag("")).toThrow();
  });
});
