import { describe, test, expect } from "bun:test";
import { join, resolve, sep } from "path";
import { isInsideDir } from "../../src/cache-layout";

const cache = resolve(join(sep, "home", "u", ".cache", "kesha"));

describe("isInsideDir (#790)", () => {
  test("a directory is inside itself", () => {
    expect(isInsideDir(cache, cache)).toBe(true);
  });

  test("a strict descendant is inside", () => {
    expect(isInsideDir(join(cache, "engine"), cache)).toBe(true);
    expect(isInsideDir(join(cache, "engine", "bin"), cache)).toBe(true);
  });

  test("a sibling whose name merely shares the prefix is outside", () => {
    expect(isInsideDir(`${cache}-alt`, cache)).toBe(false);
    expect(isInsideDir(`${cache}2`, cache)).toBe(false);
    expect(isInsideDir(join(`${cache}-old`, "engine"), cache)).toBe(false);
  });

  test("an unrelated path is outside", () => {
    expect(isInsideDir(resolve(join(sep, "opt", "kesha")), cache)).toBe(false);
  });

  test("the parent of the cache is outside", () => {
    expect(isInsideDir(resolve(join(cache, "..")), cache)).toBe(false);
  });

  test("trailing separators do not change the answer", () => {
    expect(isInsideDir(join(cache, "engine"), `${cache}${sep}`)).toBe(true);
    expect(isInsideDir(`${cache}${sep}`, cache)).toBe(true);
    expect(isInsideDir(`${cache}-alt`, `${cache}${sep}`)).toBe(false);
  });

  test("unnormalised traversal is resolved before comparing", () => {
    expect(isInsideDir(join(cache, "engine", "bin", "..", ".."), cache)).toBe(true);
    expect(isInsideDir(join(cache, "..", "kesha-alt"), cache)).toBe(false);
  });
});
