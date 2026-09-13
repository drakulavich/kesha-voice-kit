import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { harnessHome } from "../helpers/harness-home";

const HOME = "/Users/ira";
const PINNED = join(HOME, ".cache", "kesha");
const privateHome = () => "/tmp/kesha-tests/kesha-home-abc";

describe("harnessHome", () => {
  test("an inherited empty KESHA_CACHE_DIR is pinned to the real default, never moved under the private home", () => {
    expect(harnessHome({ KESHA_CACHE_DIR: "" }, privateHome, HOME)).toEqual({
      KESHA_CACHE_DIR: PINNED,
      KESHA_HOME: "/tmp/kesha-tests/kesha-home-abc",
    });
  });

  test("an unset KESHA_CACHE_DIR is pinned the same way", () => {
    expect(harnessHome({}, privateHome, HOME)?.KESHA_CACHE_DIR).toBe(PINNED);
  });

  test("a KESHA_CACHE_DIR the lane set stays where it points", () => {
    expect(harnessHome({ KESHA_CACHE_DIR: "/mnt/models" }, privateHome, HOME)?.KESHA_CACHE_DIR).toBe("/mnt/models");
  });

  test("a KESHA_HOME the caller set is left alone and no private home is created", () => {
    const refuse = () => {
      throw new Error("must not create a directory");
    };
    expect(harnessHome({ KESHA_HOME: "/srv/ci/home", KESHA_CACHE_DIR: "" }, refuse, HOME)).toBeUndefined();
  });
});
