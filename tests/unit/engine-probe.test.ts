import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enginePublishesJson } from "../helpers/engine-probe";

const posixTest = process.platform === "win32" ? test.skip : test;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stageEngine(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kesha-engine-probe-"));
  dirs.push(dir);
  const binPath = join(dir, "kesha-engine");
  writeFileSync(binPath, body);
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("enginePublishesJson", () => {
  test("an absent binary publishes nothing", () => {
    expect(enginePublishesJson(join(tmpdir(), "kesha-absent-engine"), "--error-codes-json")).toBe(false);
  });

  // The #796 stub: exits 0 for every flag and answers nothing. `existsSync` and a bare
  // exit-code probe both pass it, which is what un-skipped the drift test into a crash.
  posixTest("an engine that exits 0 and prints nothing publishes nothing", () => {
    expect(enginePublishesJson(stageEngine("#!/bin/sh\nexit 0\n"), "--error-codes-json")).toBe(false);
  });

  posixTest("an engine that fails the flag publishes nothing", () => {
    expect(enginePublishesJson(stageEngine("#!/bin/sh\nexit 2\n"), "--error-codes-json")).toBe(false);
  });

  posixTest("an engine that prints non-JSON publishes nothing", () => {
    expect(enginePublishesJson(stageEngine("#!/bin/sh\necho not-json\n"), "--error-codes-json")).toBe(false);
  });

  // An empty array parses, so parseability alone would still let a hollow engine through.
  posixTest("an engine that publishes an empty list publishes nothing", () => {
    expect(enginePublishesJson(stageEngine("#!/bin/sh\necho '[]'\n"), "--error-codes-json")).toBe(false);
  });

  posixTest("an engine that answers the flag with entries publishes them", () => {
    const bin = stageEngine("#!/bin/sh\necho '[{\"code\":\"E_DEMO\"}]'\n");
    expect(enginePublishesJson(bin, "--error-codes-json")).toBe(true);
  });
});
