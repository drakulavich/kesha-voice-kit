import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
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

  test("uninstall with KESHA_CACHE_DIR at the target of a symlinked real cache is refused (#1634)", () => {
    const target = join(tempDir("kesha-guard-target-"), "kesha");
    mkdirSync(target);
    const real = join(tempDir("kesha-guard-link-"), "kesha");
    symlinkSync(target, real, "junction");

    expect(() => refuseRealCache(["uninstall", "--yes"], { HOME: tempDir("kesha-guard-home-"), KESHA_CACHE_DIR: target }, [real], process.cwd())).toThrow(
      `its Model cache ${target} is the real cache ${real}`,
    );
  });

  test("uninstall with KESHA_CACHE_DIR at a symlink to the real cache is refused (#1634)", () => {
    const real = join(tempDir("kesha-guard-pinned-"), "kesha");
    mkdirSync(real);
    const link = join(tempDir("kesha-guard-link-"), "kesha");
    symlinkSync(real, link, "junction");

    expect(() => refuseRealCache(["uninstall", "--yes"], { HOME: tempDir("kesha-guard-home-"), KESHA_CACHE_DIR: link }, [real], process.cwd())).toThrow(
      `its Model cache ${link} is the real cache ${real}`,
    );
  });

  test("uninstall with KESHA_CACHE_DIR not created yet under a symlinked real cache is refused (#1634)", () => {
    const target = join(tempDir("kesha-guard-target-"), "kesha");
    mkdirSync(target);
    const real = join(tempDir("kesha-guard-link-"), "kesha");
    symlinkSync(target, real, "junction");
    const nested = join(real, "not-created");

    expect(() => refuseRealCache(["uninstall", "--yes"], { HOME: tempDir("kesha-guard-home-"), KESHA_CACHE_DIR: nested }, [real], process.cwd())).toThrow(
      `its Model cache ${nested} is the real cache ${real}`,
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

  test("uninstall --help removes nothing and may use the real cache", () => {
    const real = join(tempDir("kesha-guard-pinned-"), "kesha");

    expect(() => refuseRealCache(["uninstall", "--help"], { HOME: tempDir("kesha-guard-home-"), KESHA_CACHE_DIR: real }, [real], process.cwd())).not.toThrow();
  });

  test("other commands may use the real cache", () => {
    const real = join(tempDir("kesha-guard-pinned-"), "kesha");

    expect(() => refuseRealCache(["status", "--disk"], { HOME: tempDir("kesha-guard-home-"), KESHA_CACHE_DIR: real }, [real], process.cwd())).not.toThrow();
  });
});
