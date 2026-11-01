import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RemovalFailure, removeAround } from "../../src/cli/uninstall";
import { tempDir } from "../helpers/temp-dir";

describe("removeAround", () => {
  test("the held install lock inside engine/ survives while everything else in engine/ goes", () => {
    const engine = join(tempDir("kesha-uninstall-remove-"), "engine");
    const lock = join(engine, "bin", "kesha-engine.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner-x.json"), "{}");
    writeFileSync(join(engine, "bin", "kesha-engine"), "x");
    mkdirSync(join(engine, "lib"));
    writeFileSync(join(engine, "lib", "libonnx.so"), "x");
    const failures: RemovalFailure[] = [];

    const walked = removeAround(engine, [lock], failures);

    expect(failures).toEqual([]);
    expect(existsSync(join(lock, "owner-x.json"))).toBe(true);
    expect(existsSync(join(engine, "bin", "kesha-engine"))).toBe(false);
    expect(existsSync(join(engine, "lib"))).toBe(false);
    expect(walked).toEqual([engine, join(engine, "bin")]);
  });
});

describe("removeAround on a path that changed after the plan", () => {
  test("a directory that is already gone is not a failure", () => {
    const gone = join(tempDir("kesha-uninstall-gone-"), "engine");
    const failures: RemovalFailure[] = [];

    expect(removeAround(gone, [join(gone, "bin", "kesha-engine.lock")], failures)).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("a file where the directory was is removed like any entry", () => {
    const file = join(tempDir("kesha-uninstall-file-"), "engine");
    writeFileSync(file, "x");
    const failures: RemovalFailure[] = [];

    removeAround(file, [join(file, "bin", "kesha-engine.lock")], failures);

    expect(failures).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});
