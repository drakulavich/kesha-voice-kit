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
