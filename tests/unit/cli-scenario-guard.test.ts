import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { refuseRealCache } from "../integration/cli-scenario";
import { tempDir } from "../helpers/temp-dir";

describe("refuseRealCache (#1631)", () => {
  test("uninstall without its own KESHA_CACHE_DIR is refused when the default cache is the real one", () => {
    const home = tempDir("kesha-guard-home-");
    const real = join(home, ".cache", "kesha");

    expect(() => refuseRealCache(["uninstall", "--yes"], { HOME: home }, [real], process.cwd())).toThrow(
      `refusing \`kesha uninstall --yes\`: its Model cache ${real} is the real cache ${real}; give the scenario its own KESHA_CACHE_DIR (#1631)`,
    );
  });

  test("uninstall with KESHA_CACHE_DIR inherited at the real cache is refused", () => {
    const real = join(tempDir("kesha-guard-pinned-"), "kesha");

    expect(() => refuseRealCache(["uninstall", "--yes"], { HOME: tempDir("kesha-guard-home-"), KESHA_CACHE_DIR: real }, [real], process.cwd())).toThrow(
      `its Model cache ${real} is the real cache ${real}`,
    );
  });

  test("uninstall with a private cache runs", () => {
    const real = join(tempDir("kesha-guard-pinned-"), "kesha");
    const own = join(tempDir("kesha-guard-own-"), "cache");

    expect(() => refuseRealCache(["uninstall", "--yes"], { HOME: tempDir("kesha-guard-home-"), KESHA_CACHE_DIR: own }, [real], process.cwd())).not.toThrow();
  });

  test("a relative KESHA_CACHE_DIR is resolved against the scenario cwd, as the CLI does", () => {
    const real = join(tempDir("kesha-guard-pinned-"), "kesha");

    expect(() => refuseRealCache(["uninstall", "--yes"], { HOME: tempDir("kesha-guard-home-"), KESHA_CACHE_DIR: "." }, [real], real)).toThrow(
      `its Model cache ${real} is the real cache ${real}`,
    );
  });

  test("other commands may use the real cache", () => {
    const real = join(tempDir("kesha-guard-pinned-"), "kesha");

    expect(() => refuseRealCache(["status", "--disk"], { HOME: tempDir("kesha-guard-home-"), KESHA_CACHE_DIR: real }, [real], process.cwd())).not.toThrow();
  });
});
